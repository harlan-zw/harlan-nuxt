import { resolveCloudflareBindings as resolveBindings, runtimeConfigSource } from '@harlan-zw/nuxt-cloudflare/bindings'

export { runtimeConfigSource }

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

export function resolveCloudflareBindings(): Record<string, unknown> | undefined {
  return resolveBindings<Record<string, unknown>>()
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
