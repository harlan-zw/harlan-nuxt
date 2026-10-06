import { getIsolationScope, setTag } from '@sentry/cloudflare'
import { describe, expect, it, vi } from 'vitest'
import { sentryCloudflareNitroPlugin } from '../src/runtime/server/cloudflare-sdk'

vi.mock('nitro/app', () => ({ useNitroHooks: () => ({ hook: vi.fn() }) }))

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, resolve: () => release() }
}

describe('cloudflare SDK request boundary', () => {
  it('keeps concurrent request tags isolated after an await', async () => {
    const first = deferred()
    const second = deferred()
    const app = { fetch: async (request: Request) => {
      const id = request.headers.get('x-request-id')!
      setTag('request-id', id)
      if (id === 'first') {
        first.resolve()
        await second.promise
      }
      else {
        second.resolve()
        await Promise.resolve()
      }
      return new Response(String(getIsolationScope().getScopeData().tags['request-id']))
    } }
    sentryCloudflareNitroPlugin({ enabled: false, tracesSampleRate: 0 })(app as never)
    const pending = app.fetch(new Request('https://example.test/first', { headers: { 'x-request-id': 'first' } }))
    await first.promise
    const other = await app.fetch(new Request('https://example.test/second', { headers: { 'x-request-id': 'second' } }))
    expect(await (await pending).text()).toBe('first')
    expect(await other.text()).toBe('second')
  })
  it('runs a native request through the installed SDK without changing its response', async () => {
    const handler = vi.fn(async (request: Request) => new Response(request.url, { status: 202 }))
    const app = { fetch: handler }
    const pending: Promise<unknown>[] = []
    const request = Object.assign(new Request('https://example.test/api/query'), {
      runtime: { cloudflare: { context: { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } } },
    })
    // Disable delivery while exercising the SDK's real request isolation wrapper.
    sentryCloudflareNitroPlugin({ enabled: false, tracesSampleRate: 0 })(app as never)
    const response = await app.fetch(request)
    expect(response.status).toBe(202)
    expect(await response.text()).toBe(request.url)
    expect(handler).toHaveBeenCalledWith(request)
    await Promise.all(pending)
  })
})
