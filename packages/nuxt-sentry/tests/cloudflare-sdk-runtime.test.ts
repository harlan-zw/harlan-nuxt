import { describe, expect, it, vi } from 'vitest'
import { sentryCloudflareNitroPlugin } from '../src/runtime/server/cloudflare-sdk'

vi.mock('nitro/app', () => ({ useNitroHooks: () => ({ hook: vi.fn() }) }))

describe('cloudflare SDK request boundary', () => {
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
