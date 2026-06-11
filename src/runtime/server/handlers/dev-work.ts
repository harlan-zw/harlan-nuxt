import type { H3Event } from 'h3'
import { defineEventHandler, getQuery } from 'h3'
// @ts-expect-error - nitropack/runtime is resolved at build time inside Nuxt
import { useNitroApp, useRuntimeConfig } from 'nitropack/runtime'
import { createD1DurableJobRepository } from '../d1'
import { findD1Binding, markWorkerActive, resolveQueueWorkerConfig, runDevWorkerTick } from '../dev-worker'
import { recentTerminalJobs, snapshotDurableQueues } from '../dev-worker-snapshot'
import { findDispatchableDurableJobs } from '../outbox'

/** Nitro's `useNitroApp()` typing doesn't declare the runtime `cloudflare:queue` hook, so narrow to what we call. */
interface QueueConsumerHost {
  hooks: { callHook: (name: string, payload: unknown) => Promise<unknown> }
}
interface CfJobsRuntimeConfig { cfJobs?: { queues?: Record<string, string | { maxConcurrency?: number, maxBatchSize?: number }> } }

/**
 * Dev-only worker endpoint. Registered ONLY when `nuxt.options.dev` (see
 * module.ts) and guarded again here — it is an unauthenticated job executor by
 * design and must never reach a deployment. Driven by `cf-jobs work`, it finds
 * ready durable jobs in D1 and runs them through the app's `cloudflare:queue`
 * consumer IN THIS dev process, so an already-connected WebSocket sees live
 * progress. See `dev-worker.ts` for the rationale.
 */
export default defineEventHandler(async (event: H3Event) => {
  if (!import.meta.dev)
    return { processed: 0, byQueue: {}, remaining: 0, error: 'dev-only' }

  const query = getQuery(event)
  // This poll is the worker's heartbeat: refresh the lease so the dev queue keeps
  // deferring auto-dispatch to us (see the dev-queues plugin) for the next ~15s.
  // `lease=0` is a pure read-only observer (`cf-jobs watch` for agents): it must
  // NOT hold the lease, or it would defer execution to a worker that isn't there.
  if (pickString(query.lease) !== '0')
    markWorkerActive()

  const limit = clampInt(query.limit, 100, 1, 1000)
  const onlyQueue = pickString(query.queue)
  const preferredDb = pickString(query.db)

  const env = resolveEnv(event)
  const d1 = findD1Binding(env, preferredDb)
  if (!d1)
    return { processed: 0, byQueue: {}, remaining: 0, error: 'no-d1-binding' }

  const repo = createD1DurableJobRepository(d1.db)
  const queues = (useRuntimeConfig() as CfJobsRuntimeConfig).cfJobs?.queues ?? {}

  // `drain=0`: the lane scheduler's demand read — refresh the lease and report
  // state without running a tick (it drives draining via per-queue calls instead).
  const result = pickString(query.drain) === '0'
    ? { processed: 0, byQueue: {} as Record<string, number>, remaining: 0 }
    : await runDevWorkerTick({
        findDispatchable: max => findDispatchableDurableJobs(repo, { limit: max }),
        queueConfig: queue => resolveQueueWorkerConfig(queues[queue]),
        async dispatchBatch(queue, messages) {
          // Fire the registered consumer in-process and await it — the handler (and
          // any WS broadcast) runs before this resolves. ack/retry are no-ops: the
          // durable consumer tracks state in D1, not via queue ack.
          const nitroApp = useNitroApp() as unknown as QueueConsumerHost
          await nitroApp.hooks.callHook('cloudflare:queue', {
            batch: {
              queue,
              messages: messages.map(body => ({ id: body.jobId, body, attempts: 1, ack() {}, retry() {} })),
              ackAll() {},
              retryAll() {},
            },
            env,
          })
        },
      }, { limit, queue: onlyQueue })

  const base = d1.ambiguous ? { ...result, d1Binding: d1.binding, ambiguousBindings: d1.ambiguous } : result

  // `?snapshot=1` (the `--watch` dashboard / lane scheduler) asks for the live D1
  // view too. Read-only and best-effort: if the snapshot queries fail (e.g. tables
  // not migrated yet), still return the tick result so draining never breaks on a
  // reporting error. Each queue is enriched with its wrangler consumer config so
  // the scheduler knows the per-queue lane budget.
  if (pickString(query.snapshot) !== '1')
    return base
  // `since` (the agent stream cursor) widens the cap so a burst between polls is
  // never truncated; otherwise it's the dashboard's small recent window.
  const sinceSeconds = pickString(query.since) ? clampInt(query.since, 0, 0, Number.MAX_SAFE_INTEGER) : undefined
  const recentLimit = sinceSeconds !== undefined ? 500 : clampInt(query.recent, 12, 1, 50)
  return await Promise.all([
    snapshotDurableQueues(d1.db),
    recentTerminalJobs(d1.db, { limit: recentLimit, sinceSeconds }),
  ])
    .then(([snapshot, recent]) => ({
      ...base,
      snapshot: snapshot.map(q => ({ ...q, ...resolveQueueWorkerConfig(queues[q.queue]) })),
      recent,
    }))
    .catch(() => base)
})

function resolveEnv(event: H3Event): Record<string, unknown> {
  const fromEvent = (event.context.cloudflare as { env?: Record<string, unknown> } | undefined)?.env
  const fromGlobal = (globalThis as { __env__?: Record<string, unknown> }).__env__
  return { ...(fromGlobal ?? {}), ...(fromEvent ?? {}) }
}

function pickString(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(Array.isArray(value) ? value[0] : value)
  if (!Number.isFinite(n))
    return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}
