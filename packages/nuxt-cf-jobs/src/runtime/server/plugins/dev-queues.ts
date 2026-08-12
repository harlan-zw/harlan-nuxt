// @ts-expect-error - nitropack/runtime is resolved at build time inside Nuxt
import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime'
import { createDevQueueRuntime } from '../dev'
import { isWorkerActive } from '../dev-worker'
import { mergeNitroTaskEnv, resolveCloudflareBindings } from '../runtime-env'

interface NitroAppLike {
  hooks: {
    hook: (name: string, handler: (...args: any[]) => any) => void
    callHook: (name: string, payload: unknown) => Promise<unknown>
  }
}

interface RequestEventLike {
  context: {
    cloudflare?: { env?: Record<string, unknown> } & Record<string, unknown>
  }
}

export default defineNitroPlugin((nitroApp: NitroAppLike) => {
  const config = useRuntimeConfig().cfJobs as { queues?: Record<string, string | { binding: string }> } | undefined
  const queues = config?.queues ?? {}
  if (!Object.keys(queues).length)
    return

  const runtime = createDevQueueRuntime({
    queues,
    onBatch: async (payload: { batch: unknown, env?: Record<string, unknown> }) => {
      // The in-process runtime's env carries only the queue bindings, but the
      // consumer also needs the base Cloudflare bindings (D1/KV/…). In dev those
      // live on the task-env shim (`globalThis.__env__`), so merge them in
      // (queue bindings win) — otherwise the consumer's `createContext` throws on
      // a missing binding (e.g. the D1 database) the moment a job actually runs.
      const baseEnv = resolveCloudflareBindings() ?? {}
      await nitroApp.hooks.callHook('cloudflare:queue', {
        ...payload,
        env: { ...baseEnv, ...(payload.env ?? {}) },
      })
    },
    onError(error) {
      console.error('[nuxt-cf-jobs] dev queue error:', error)
    },
    // While `cf-jobs work` is polling, defer auto-dispatch: durable rows stay in
    // D1 for the worker to drain out-of-band (so a connected WebSocket observes
    // live progress). The worker's poll refreshes the lease; when it stops, the
    // lease lapses and auto-dispatch resumes on its own.
    shouldAutoDispatch: () => !isWorkerActive(),
  })

  // Requests get the in-process queue runtime via the hook above, but scheduled
  // tasks, fan-outs and hook listeners enqueue through `getQueue(job)`, which has
  // no `H3Event` and resolves bindings via `resolveCloudflareBindings()` →
  // `globalThis.__env__`. Without mirroring the runtime there, those jobs enqueue
  // to nothing in dev and silently never run. Expose the same queue bindings on
  // the task-env shim so task/listener-triggered jobs process in dev too. Any
  // real binding already on the shim wins, matching the request precedence above.
  // (This plugin is only registered in dev — see module.ts — so it never touches
  // production env.)
  mergeNitroTaskEnv(runtime.env, resolveCloudflareBindings())

  nitroApp.hooks.hook('request', (event: RequestEventLike) => {
    const existing = event.context.cloudflare?.env
    // The in-process dev queue bindings MUST win over miniflare's native queue
    // producer bindings (nitro-cloudflare-dev instantiates `existing.QUEUE_*`
    // from the wrangler config). If native wins, a request-path `.send()` routes
    // to miniflare's native queue, whose consumer is NOT wired to nitro's
    // `cloudflare:queue` hook — so durable jobs enqueue but never get claimed and
    // the batch silently never drains. Native non-queue bindings (D1/KV/R2) are
    // preserved: `runtime.env` only ever contains queue bindings.
    event.context.cloudflare = {
      ...(event.context.cloudflare ?? {}),
      env: existing ? { ...existing, ...runtime.env } : runtime.env,
    }
    // Mirror nuxt-dev's NATIVE bindings (D1/KV/R2/…) onto the task-env shim too,
    // so the ASYNC queue consumer (`onBatch` → `cloudflare:queue`, which runs
    // outside the request and reads `globalThis.__env__`) can reach them. Without
    // this the consumer's env has only the dev queue bindings, and any job that
    // touches D1 fails to claim — the batch silently never drains in dev. Queue
    // bindings keep precedence over the native env.
    if (existing)
      mergeNitroTaskEnv(resolveCloudflareBindings(), existing, runtime.env)
  })

  nitroApp.hooks.hook('close', () => runtime.dispose())
})
