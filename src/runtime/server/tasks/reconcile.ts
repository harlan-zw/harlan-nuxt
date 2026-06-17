import { useRuntimeConfig } from 'nitropack/runtime'
import { createD1DurableBatchStore } from '../batch'
import { createD1DurableJobRepository } from '../d1'
import { findD1Binding } from '../dev-worker'
import { createQueuePublisher } from '../outbox'
import { resolveNitroTaskEnv } from '../queue'
import { recoverDurableJobs } from '../recovery'
import { defineScheduledTask } from '../scheduled'

// cf-jobs recovery backstop (the "app's own reconcile cron" the durable-queue
// runtime documents as required). Two failure modes leave a durable job stranded
// with no queue message to re-trigger it, and nothing else recovers them:
//
//   1. A consumer reserves a job, then the isolate is recycled / hits a limit
//      before it completes or releases → the row stays `reserved` forever.
//   2. `onFinish` / a release path persists a follow-up row but the queue send is
//      skipped (no binding) or throws → the row is `ready` but undispatched.
//
// This task, on a short cron, reclaims (1) via `releaseStaleReservedDurableJobs`
// and re-dispatches both (1, now released) and old due rows from (2).
// Module-owned so every consuming app gets the backstop without copying it.
//
// Resilient by construction: every early-out returns a tagged skip rather than
// throwing, so a missing binding in one env can't crash the cron.
interface ReconcileRuntimeConfig {
  cfJobs?: {
    queues?: Record<string, { binding?: string } | string>
    reconcile?: {
      d1Binding?: string
      staleSeconds?: number
      orphanedSeconds?: number
      orphanedBatchSeconds?: number
      limit?: number
    }
  }
}

// Run a trivial query to confirm a binding is a real, working D1 — an RPC stub
// (Durable Object / service binding) duck-types as D1 but throws `The RPC
// receiver does not implement the method "prepare"` when actually invoked.
async function probeD1(db: unknown): Promise<boolean> {
  try {
    await (db as { prepare: (sql: string) => { first: () => Promise<unknown> } }).prepare('SELECT 1').first()
    return true
  }
  catch {
    return false
  }
}

export default defineScheduledTask({
  name: 'cf-jobs:reconcile',
  // Every 2 minutes — fast enough that a stranded job (e.g. a batch member whose
  // onFinish assessment never dispatched) recovers well within a user's session.
  cron: '*/2 * * * *',
  description: 'cf-jobs recovery backstop: reclaim stale-reserved jobs + re-dispatch orphaned ready jobs',
  async run() {
    const env = resolveNitroTaskEnv()
    if (!env)
      return { result: { skipped: 'no-env' as const } }

    const rc = useRuntimeConfig() as ReconcileRuntimeConfig
    const reconcile = rc.cfJobs?.reconcile ?? {}

    let d1 = findD1Binding(env, reconcile.d1Binding)
    if (!d1)
      return { result: { skipped: 'no-d1-binding' as const } }

    // `findD1Binding` duck-types `prepare`/`exec`, which an RPC stub (a Durable
    // Object / service binding on the `cloudflare-durable` preset) also satisfies
    // — but invoking `.prepare()` on a stub throws `The RPC receiver does not
    // implement the method`. This bit even the PINNED path: a pinned binding name
    // that resolves to a stub in the task context was trusted unprobed, so
    // reconcile silently `recovery-error`'d every tick. So ALWAYS probe the
    // resolved binding (pinned or scanned); if it fails, scan every binding and
    // pick the first that answers a trivial query.
    if (!(await probeD1(d1.db))) {
      let working: { binding: string, db: typeof d1.db } | undefined
      for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
        if (value && typeof (value as { prepare?: unknown }).prepare === 'function' && await probeD1(value)) {
          working = { binding: name, db: value as typeof d1.db }
          break
        }
      }
      if (!working) {
        console.warn(
          `[cf-jobs:reconcile] D1 binding "${d1.binding}" failed a probe (likely an RPC stub in this task context) and no other binding answered — skipping. Pin a real D1 via cfJobs.reconcile.d1Binding.`,
        )
        return { result: { skipped: 'no-working-d1-binding' as const } }
      }
      if (working.binding !== d1.binding)
        console.warn(`[cf-jobs:reconcile] D1 binding "${d1.binding}" failed a probe; using "${working.binding}".`)
      d1 = working
    }

    const queues = rc.cfJobs?.queues ?? {}
    const repo = createD1DurableJobRepository(d1.db)
    const store = createD1DurableBatchStore(d1.db)
    // Map a job's logical queue → its env binding name. `queues[q]` is either the
    // binding string or the enriched `{ binding, ... }` object (prod path).
    const publisher = createQueuePublisher(env, (queue: string) => {
      const entry = queues[queue]
      return typeof entry === 'string' ? entry : entry?.binding
    }, {
      // A missing/stub queue producer binding (no `.send` in this task context)
      // would otherwise drop re-dispatches silently — surface it loudly so a
      // swept-but-not-dispatched tick is diagnosable.
      onMissingBinding: (queue, count) =>
        console.warn(`[cf-jobs:reconcile] no working queue producer binding for "${queue}" — ${count} message(s) NOT dispatched (binding missing or lacks .send here).`),
    })

    const staleSeconds = reconcile.staleSeconds ?? 300
    const orphanedSeconds = reconcile.orphanedSeconds ?? 600
    const orphanedBatchSeconds = reconcile.orphanedBatchSeconds ?? 7 * 86400
    const limit = reconcile.limit ?? 100
    const nowSeconds = Math.floor(Date.now() / 1000)

    // The task fires every 2 minutes; a D1/queue failure here must not surface as
    // a recurring unhandled worker exception (Sentry noise, red tail). Degrade to
    // a tagged skip + one warning so a misconfigured env is visible but inert.
    try {
      const recovered = await recoverDurableJobs(repo, publisher, {
        now: nowSeconds,
        staleSeconds,
        orphanedSeconds,
        limit,
        staleError: 'stale-reservation',
      })
      const orphanedBatches = await store.finishOrphanedBatches?.({
        before: nowSeconds - orphanedBatchSeconds,
        now: nowSeconds,
        limit,
      }) ?? 0

      const result = {
        released: recovered.released,
        swept: recovered.swept,
        dispatched: recovered.dispatched,
        orphanedBatches,
      }
      // Surface a tick that actually did (or should have done) work, so a
      // recovering backlog — or a swept-but-not-dispatched stall — is visible in
      // logs instead of hiding in the (un-logged) task return value.
      if (result.swept > 0 || result.released > 0 || result.orphanedBatches > 0)
        console.warn(`[cf-jobs:reconcile] ${JSON.stringify(result)}`)
      return { result }
    }
    catch (error) {
      console.warn(`[cf-jobs:reconcile] recovery failed on binding "${d1.binding}": ${(error as Error)?.message ?? error}`)
      return { result: { skipped: 'recovery-error' as const } }
    }
  },
})
