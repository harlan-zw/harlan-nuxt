import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sentryCloudflareNitroPlugin } from '../src/runtime/server/cloudflare-sdk'

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  wrapRequestHandler: vi.fn(async (_options: unknown, handler: () => Promise<Response>) => handler()),
  error: undefined as undefined | ((error: Error) => void),
}))
vi.mock('@sentry/cloudflare', () => ({ captureException: mocks.captureException, getDefaultIntegrations: () => [], setAsyncLocalStorageAsyncContextStrategy: vi.fn() }))
vi.mock('@sentry/cloudflare/request', () => ({ wrapRequestHandler: mocks.wrapRequestHandler }))
vi.mock('nitro/app', () => ({ useNitroHooks: () => ({ hook: (_name: string, handler: (error: Error) => void) => {
  mocks.error = handler
} }) }))

beforeEach(() => vi.clearAllMocks())

describe('nitro 3 Cloudflare instrumentation', () => {
  it('wraps the native fetch and passes its request execution context', async () => {
    const app = { fetch: async (_request: Request) => new Response('instrumented') }
    const context = { waitUntil: vi.fn() }
    const request = Object.assign(new Request('https://example.test/api/query'), { runtime: { cloudflare: { context } } })
    sentryCloudflareNitroPlugin({ dsn: 'https://public@example.test/1' })(app as never)
    const response = await app.fetch(request as never)
    expect(await response.text()).toBe('instrumented')
    expect(mocks.wrapRequestHandler).toHaveBeenCalledWith(expect.objectContaining({ request, context, captureErrors: false }), expect.any(Function))
  })

  it('reports a server failure and leaves expected client errors to the handler', () => {
    const app = { fetch: async (_request: Request) => new Response() }
    sentryCloudflareNitroPlugin({})(app as never)
    const serverError = Object.assign(new Error('DB unavailable'), { status: 500 })
    mocks.error?.(serverError)
    mocks.error?.(Object.assign(new Error('Not found'), { status: 404 }))
    expect(mocks.captureException).toHaveBeenCalledTimes(1)
    expect(mocks.captureException).toHaveBeenCalledWith(serverError, expect.objectContaining({ mechanism: { handled: false, type: 'auto.function.nuxt.nitro' } }))
  })
})
