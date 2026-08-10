export type QueueSource
  = | Record<string, unknown>
    | {
      context?: {
        cloudflare?: {
          env?: Record<string, unknown>
        } | unknown
      } | unknown
    }

type NitroTaskEnvHost = typeof globalThis & { __env__?: unknown }

function nitroTaskEnvHost(): NitroTaskEnvHost {
  return globalThis as NitroTaskEnvHost
}

/**
 * Resolves the Cloudflare runtime env from a Nitro task context where no `H3Event` is available.
 *
 * Nitro tasks (`defineTask`) run without an event, so Cloudflare bindings must be threaded through
 * `globalThis.__env__`. This helper reads that shim and returns the env (or `undefined`).
 */
export function resolveNitroTaskEnv(): Record<string, unknown> | undefined {
  const globalEnv = nitroTaskEnvHost().__env__
  if (globalEnv && typeof globalEnv === 'object')
    return globalEnv as Record<string, unknown>
  return undefined
}

export function writeNitroTaskEnv(env: Record<string, unknown> | undefined): void {
  const host = nitroTaskEnvHost()
  if (env === undefined)
    delete host.__env__
  else
    host.__env__ = env
}

export function mergeNitroTaskEnv(...sources: Array<Record<string, unknown> | undefined>): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const source of sources) {
    if (source)
      Object.assign(merged, source)
  }
  writeNitroTaskEnv(merged)
  return merged
}

export function resolveQueueSourceEnv(source: QueueSource | undefined): Record<string, unknown> | undefined {
  if (!source)
    return undefined

  const maybeEvent = source as { context?: { cloudflare?: { env?: Record<string, unknown> } } }
  return maybeEvent.context?.cloudflare?.env ?? source as Record<string, unknown>
}

/**
 * Wraps a Cloudflare env as the event-shaped source `useRuntimeConfig` expects.
 * Queue consumers run without an `H3Event`, so without this the `queues` resolver
 * would call `useRuntimeConfig()` bare and miss per-deployment `NUXT_*` env overrides.
 */
export function runtimeConfigSource(env: Record<string, unknown>): QueueSource {
  return { context: { cloudflare: { env } } }
}
