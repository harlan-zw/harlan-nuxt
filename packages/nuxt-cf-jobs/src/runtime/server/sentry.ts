import type { CloudflareOptions } from '@sentry/cloudflare'
import { setAsyncLocalStorageAsyncContextStrategy } from '@sentry/cloudflare'
// Sentry 11 removed `wrapRequestHandler` from the main entry. The `./request`
// subpath carries it on Sentry 10.70 and later, so one import serves both.
import { wrapRequestHandler } from '@sentry/cloudflare/request'

export interface QueueSentryInput {
  queue: string
  context: ExecutionContext
  options: CloudflareOptions
}

/** Runs a queue batch through Sentry's request-scoped Cloudflare client. */
export function runWithQueueSentry<T>(input: QueueSentryInput, use: () => Promise<T>): Promise<T> {
  setAsyncLocalStorageAsyncContextStrategy()
  let result: T
  return wrapRequestHandler(
    {
      options: input.options,
      request: new Request(`https://queue.internal/${input.queue}`),
      context: input.context,
    },
    async () => {
      result = await use()
      return new Response(null, { status: 204 })
    },
  ).then(() => result)
}
