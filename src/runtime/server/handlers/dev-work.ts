// @ts-expect-error - nitropack/runtime is resolved at build time inside Nuxt
import { defineEventHandler, getQuery, useNitroApp, useRuntimeConfig } from 'nitropack/runtime'
import { createD1DurableJobRepository } from '../d1'
import { findD1Binding, resolveQueueWorkerConfig, runDevWorkerTick } from '../dev-worker'
import { findDispatchableDurableJobs } from '../outbox'

interface RequestEventLike {
  context?: { cloudflare?: { env?: Record<string, unknown> } }
}

/**
 * Dev-only worker endpoint. Registered ONLY when `nuxt.options.dev` (see
 * module.ts) and guarded again here — it is an unauthenticated job executor by
 * design and must never reach a deployment. Driven by `cf-jobs work`, it finds
 * ready durable jobs in D1 and runs them through the app's `cloudflare:queue`
 * consumer IN THIS dev process, so an already-connected WebSocket sees live
 * progress. See `dev-worker.ts` for the rationale.
 */
export default defineEventHandler(async (event: RequestEventLike) => {
  if (!import.meta.dev)
    return { processed: 0, byQueue: {}, remaining: 0, error: 'dev-only' }

  const query = getQuery(event)
  const limit = clampInt(query.limit, 100, 1, 1000)
  const onlyQueue = pickString(query.queue)
  const preferredDb = pickString(query.db)

  const env = resolveEnv(event)
  const d1 = findD1Binding(env, preferredDb)
  if (!d1)
    return { processed: 0, byQueue: {}, remaining: 0, error: 'no-d1-binding' }

  const repo = createD1DurableJobRepository(d1.db)
  const nitroApp = useNitroApp()
  const queues = (useRuntimeConfig().cfJobs?.queues ?? {}) as Record<string, string | { maxConcurrency?: number, maxBatchSize?: number }>

  const result = await runDevWorkerTick({
    findDispatchable: max => findDispatchableDurableJobs(repo, { limit: max }),
    queueConfig: queue => resolveQueueWorkerConfig(queues[queue]),
    async dispatchBatch(queue, messages) {
      // Fire the registered consumer in-process and await it — the handler (and
      // any WS broadcast) runs before this resolves. ack/retry are no-ops: the
      // durable consumer tracks state in D1, not via queue ack.
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

  return d1.ambiguous ? { ...result, d1Binding: d1.binding, ambiguousBindings: d1.ambiguous } : result
})

function resolveEnv(event: RequestEventLike): Record<string, unknown> {
  const fromEvent = event.context?.cloudflare?.env
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
