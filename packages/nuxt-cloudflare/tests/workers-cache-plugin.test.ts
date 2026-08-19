import { H3Event } from 'h3'
import { describe, expect, it, vi } from 'vitest'

type Hook = (event: H3Event) => void

async function runPlugin(options: {
  routeRuleHeaders?: Record<string, string>
  requestHeaders?: Record<string, string>
  status?: number
  capabilities?: unknown
  mode?: string
}) {
  const hooks: Record<string, Hook> = {}
  // The plugin module keeps a `warnOnce` set and closes over the mocked
  // runtime config, so each case needs a fresh copy of both.
  vi.resetModules()
  vi.doMock('nitropack/runtime', () => ({
    defineNitroPlugin: (fn: (app: unknown) => void) => fn,
    useRuntimeConfig: () => ({
      nuxtCloudflare: { htmlCacheMode: options.mode ?? 'auto' },
      htmlCacheCapabilities: options.capabilities,
    }),
  }))
  const plugin = (await import('../src/runtime/server/plugins/workers-cache')).default as unknown as
    (app: { hooks: { hook: (name: string, fn: Hook) => void } }) => void

  plugin({
    hooks: {
      hook: (name, fn) => {
        hooks[name] = fn
      },
    },
  })

  const event = new H3Event(new Request('https://x.test/gh/a/b', {
    headers: { 'sec-fetch-dest': 'document', ...options.requestHeaders },
  }))

  hooks.request?.(event)
  // A rendered document. The policy applies to documents only, so without this
  // the plugin correctly leaves everything alone.
  event.res.headers.set('content-type', 'text/html; charset=utf-8')
  // Nitro's route-rule handler runs after the request hook and replaces per key.
  for (const [name, value] of Object.entries(options.routeRuleHeaders ?? {}))
    event.res.headers.set(name, value)
  if (options.status)
    event.res.status = options.status
  hooks.beforeResponse?.(event)

  return {
    browser: event.res.headers.get('cache-control'),
    edge: event.res.headers.get('cloudflare-cdn-cache-control'),
  }
}

const skew = [{
  v: 1,
  by: 'nuxt-skew-protection',
  documentTtlCeilingSeconds: 2_592_000,
  basis: 'retention-days',
  assetRecovery: true,
}]

describe('the floor must not overrule the app', () => {
  // The whole point of the change. Cloudflare reads
  // `Cloudflare-CDN-Cache-Control` ahead of `Cache-Control`, so a floor written
  // to the edge header would silently outrank every route rule that sets only
  // the browser one, and the route rule would still do nothing.
  it('leaves the edge open when the app set only cache-control', async () => {
    const headers = await runPlugin({
      routeRuleHeaders: { 'cache-control': 'public, s-maxage=300' },
      capabilities: skew,
    })

    expect(headers.browser).toBe('public, s-maxage=300')
    expect(headers.edge).toBeNull()
  })

  it('still closes the edge when nobody asked for caching', async () => {
    const headers = await runPlugin({ capabilities: skew })

    expect(headers.browser).toBe('private, no-store')
    expect(headers.edge).toBe('no-store')
  })

  it('lowers an over-long rule instead of discarding it', async () => {
    const headers = await runPlugin({
      routeRuleHeaders: { 'cache-control': 'public, s-maxage=31536000' },
      capabilities: skew,
    })

    expect(headers.browser).toBe('public, s-maxage=2592000')
  })

  it('keeps both headers when the app split them, as gscdump does', async () => {
    const headers = await runPlugin({
      routeRuleHeaders: {
        'cache-control': 'public, max-age=0, private="set-cookie"',
        'cloudflare-cdn-cache-control': 'public, max-age=3600, private="set-cookie"',
      },
      capabilities: skew,
    })

    expect(headers.browser).toBe('public, max-age=0, private="set-cookie"')
    expect(headers.edge).toBe('public, max-age=3600, private="set-cookie"')
  })

  it('refuses a credentialed request whatever the rule says', async () => {
    const headers = await runPlugin({
      routeRuleHeaders: { 'cache-control': 'public, s-maxage=300' },
      requestHeaders: { cookie: 'session=1' },
      capabilities: skew,
    })

    expect(headers.browser).toBe('private, no-store')
    expect(headers.edge).toBe('no-store')
  })

  it('overrides when nothing guarantees retention', async () => {
    const headers = await runPlugin({
      routeRuleHeaders: { 'cache-control': 'public, s-maxage=300' },
    })

    expect(headers.browser).toBe('private, no-store')
  })
})

describe('responses that are not documents', () => {
  // The regression this guards: nitro's own `/_nuxt/**` immutable rule went
  // through the document policy and came out `private, no-store`.
  it('leaves an immutable asset policy exactly as nitro wrote it', async () => {
    const hooks: Record<string, Hook> = {}
    vi.resetModules()
    vi.doMock('nitropack/runtime', () => ({
      defineNitroPlugin: (fn: (app: unknown) => void) => fn,
      useRuntimeConfig: () => ({ nuxtCloudflare: { htmlCacheMode: 'auto' } }),
    }))
    const plugin = (await import('../src/runtime/server/plugins/workers-cache')).default as unknown as
      (app: { hooks: { hook: (name: string, fn: Hook) => void } }) => void

    plugin({
      hooks: {
        hook: (name, fn) => {
          hooks[name] = fn
        },
      },
    })

    const event = new H3Event(new Request('https://x.test/_nuxt/entry.abc.js'))
    hooks.request?.(event)
    event.res.headers.set('content-type', 'text/javascript')
    event.res.headers.set('cache-control', 'public, max-age=31536000, immutable')
    hooks.beforeResponse?.(event)

    expect(event.res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })
})
