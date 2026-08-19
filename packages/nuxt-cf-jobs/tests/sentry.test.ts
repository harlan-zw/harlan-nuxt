import type { CloudflareOptions } from '@sentry/cloudflare'
import { describe, expect, it, vi } from 'vitest'
import { runWithQueueSentry } from '../src/runtime/server/sentry'

const sentry = vi.hoisted(() => ({
  responses: [] as Response[],
  setAsyncContext: vi.fn(),
  wrapRequestHandler: vi.fn(async (_options: unknown, handler: () => Promise<Response>) => {
    const response = await handler()
    sentry.responses.push(response)
    return response
  }),
}))

vi.mock('@sentry/cloudflare', () => ({
  setAsyncLocalStorageAsyncContextStrategy: sentry.setAsyncContext,
  wrapRequestHandler: sentry.wrapRequestHandler,
}))

describe('runWithQueueSentry', () => {
  it('returns the queue handler result through Sentry request instrumentation', async () => {
    const context = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext
    const options = { dsn: 'https://example.invalid/1' } satisfies CloudflareOptions

    await expect(runWithQueueSentry({ queue: 'events', context, options }, async () => 'processed')).resolves.toBe('processed')
    expect(sentry.setAsyncContext).toHaveBeenCalledOnce()
    expect(sentry.wrapRequestHandler).toHaveBeenCalledWith(
      {
        options,
        request: expect.objectContaining({ url: 'https://queue.internal/events' }),
        context,
      },
      expect.any(Function),
    )
    expect(sentry.responses[0]).toMatchObject({ status: 204 })
  })

  it('propagates queue handler failures', async () => {
    const failure = new Error('queue failed')
    const context = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext

    await expect(runWithQueueSentry(
      { queue: 'events', context, options: {} },
      async () => Promise.reject(failure),
    )).rejects.toBe(failure)
  })
})
