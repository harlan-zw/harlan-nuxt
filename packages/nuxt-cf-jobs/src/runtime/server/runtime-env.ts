export type QueueSource
  = | Record<string, unknown>
    | {
      context?: {
        cloudflare?: {
          env?: Record<string, unknown>
        } | unknown
      } | unknown
    }

export function resolveQueueSourceEnv(source: QueueSource | undefined): Record<string, unknown> | undefined {
  if (!source)
    return undefined

  const maybeEvent = source as { context?: { cloudflare?: { env?: Record<string, unknown> } } }
  return maybeEvent.context?.cloudflare?.env ?? source as Record<string, unknown>
}
