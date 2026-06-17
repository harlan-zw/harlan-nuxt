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

    const d1 = findD1Binding(env, reconcile.d1Binding)
    if (!d1)
      return { result: { skipped: 'no-d1-binding' as const } }

    const queues = rc.cfJobs?.queues ?? {}
    const repo = createD1DurableJobRepository(d1.db)
    const store = createD1DurableBatchStore(d1.db)
    // Map a job's logical queue → its env binding name. `queues[q]` is either the
    // binding string or the enriched `{ binding, ... }` object (prod path).
    const publisher = createQueuePublisher(env, (queue: string) => {
      const entry = queues[queue]
      return typeof entry === 'string' ? entry : entry?.binding
    })

    const staleSeconds = reconcile.staleSeconds ?? 300
    const orphanedSeconds = reconcile.orphanedSeconds ?? 600
    const orphanedBatchSeconds = reconcile.orphanedBatchSeconds ?? 7 * 86400
    const limit = reconcile.limit ?? 100
    const nowSeconds = Math.floor(Date.now() / 1000)

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

    return {
      result: {
        released: recovered.released,
        swept: recovered.swept,
        dispatched: recovered.dispatched,
        orphanedBatches,
      },
    }
  },
})
