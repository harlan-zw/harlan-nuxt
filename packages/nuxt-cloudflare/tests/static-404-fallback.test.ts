import type { LocalFetch, NativeFetch, WorkerRequest } from '../src/runtime/server/utils/request-lifetime'
import type { AssetsFetcher } from '../src/runtime/server/utils/static-404-fallback'
import { describe, expect, it, vi } from 'vitest'
import {
  fetchStatic404Asset,
  resolveStatic404FallbackPolicy,
  shouldServeStatic404Fallback,
  wrapLocalFetchWithStatic404,
  wrapNativeFetchWithStatic404,
} from '../src/runtime/server/utils/static-404-fallback'

describe('resolveStatic404FallbackPolicy', () => {
  it('defaults to disabled and enables with /404.html', () => {
    expect(resolveStatic404FallbackPolicy(undefined)).toEqual({ _tag: 'disabled' })
    expect(resolveStatic404FallbackPolicy(false)).toEqual({ _tag: 'disabled' })
    expect(resolveStatic404FallbackPolicy(true)).toEqual({ _tag: 'enabled', assetPath: '/404.html' })
    expect(resolveStatic404FallbackPolicy({ assetPath: '/errors/404.html' })).toEqual({
      _tag: 'enabled',
      assetPath: '/errors/404.html',
    })
  })

  it('rejects relative, traversal, or query-bearing asset paths', () => {
    expect(() => resolveStatic404FallbackPolicy({ assetPath: '404.html' })).toThrow('assetPath')
    expect(() => resolveStatic404FallbackPolicy({ assetPath: '/../secret.html' })).toThrow('assetPath')
    expect(() => resolveStatic404FallbackPolicy({ assetPath: '/404.html?x=1' })).toThrow('assetPath')
  })
})

describe('shouldServeStatic404Fallback', () => {
  const base = () => ({
    errorPathname: '/__nuxt_error',
    errorSearchParams: new URLSearchParams('status=404&url=%2Fdocs%2Fmissing'),
    isInternalErrorRender: true,
    method: 'GET',
    headers: new Headers({ accept: 'text/html,application/xhtml+xml' }),
  })

  it('serves static 404 for internal HTML GET and HEAD 404 renders', () => {
    expect(shouldServeStatic404Fallback(base())).toEqual({ _tag: 'serve-static' })
    expect(shouldServeStatic404Fallback({ ...base(), method: 'HEAD' })).toEqual({ _tag: 'serve-static' })
    expect(shouldServeStatic404Fallback({
      ...base(),
      errorPathname: '/sub/__nuxt_error',
      errorSearchParams: new URLSearchParams('statusCode=404&url=%2Fdocs%2Fmissing'),
    })).toEqual({ _tag: 'serve-static' })
  })

  it('skips non-error routes, direct visits, non-404 statuses, non-GET/HEAD methods, and JSON/API requests', () => {
    expect(shouldServeStatic404Fallback({ ...base(), errorPathname: '/docs/missing' }))
      .toEqual({ _tag: 'pass', reason: 'not-error-route' })
    expect(shouldServeStatic404Fallback({ ...base(), isInternalErrorRender: false }))
      .toEqual({ _tag: 'pass', reason: 'not-internal-render' })
    expect(shouldServeStatic404Fallback({ ...base(), errorSearchParams: new URLSearchParams('status=500') }))
      .toEqual({ _tag: 'pass', reason: 'not-404' })
    expect(shouldServeStatic404Fallback({ ...base(), method: 'POST' }))
      .toEqual({ _tag: 'pass', reason: 'unsupported-method' })
    expect(shouldServeStatic404Fallback({ ...base(), headers: new Headers({ accept: 'application/json' }) }))
      .toEqual({ _tag: 'pass', reason: 'json-or-api-request' })
    expect(shouldServeStatic404Fallback({
      ...base(),
      errorSearchParams: new URLSearchParams('status=404&url=%2Fapi%2Fmissing'),
    })).toEqual({ _tag: 'pass', reason: 'json-or-api-request' })
    expect(shouldServeStatic404Fallback({
      ...base(),
      headers: new Headers({ 'sec-fetch-mode': 'cors' }),
    })).toEqual({ _tag: 'pass', reason: 'json-or-api-request' })
    expect(shouldServeStatic404Fallback({
      ...base(),
      headers: new Headers({ 'user-agent': 'curl/8.7.1' }),
    })).toEqual({ _tag: 'pass', reason: 'json-or-api-request' })
  })
})

describe('fetchStatic404Asset', () => {
  it('returns status 404 HTML response when ASSETS serves /404.html', async () => {
    const assets: AssetsFetcher = {
      fetch: vi.fn(async (input) => {
        const req = input instanceof Request ? input : new Request(input)
        expect(new URL(req.url).pathname).toBe('/404.html')
        return new Response('<html><body>Static 404</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }),
    }

    const result = await fetchStatic404Asset({
      assets,
      requestUrl: 'https://example.test/docs/missing',
      assetPath: '/404.html',
      method: 'GET',
    })

    expect(result._tag).toBe('hit')
    if (result._tag !== 'hit')
      return
    expect(result.response.status).toBe(404)
    expect(result.response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(result.response.headers.get('cache-control')).toBe('private, no-store')
    expect(result.response.headers.get('x-robots-tag')).toBe('noindex')
    await expect(result.response.text()).resolves.toBe('<html><body>Static 404</body></html>')
  })

  it('reports miss reasons cleanly when ASSETS is absent, 404s, returns non-HTML, or throws', async () => {
    expect(await fetchStatic404Asset({ assets: undefined, requestUrl: 'https://example.test/x' }))
      .toEqual({ _tag: 'miss', reason: 'no-assets-binding' })

    const missingAssets: AssetsFetcher = {
      fetch: async () => new Response('missing', { status: 404 }),
    }
    expect(await fetchStatic404Asset({ assets: missingAssets, requestUrl: 'https://example.test/x' }))
      .toEqual({ _tag: 'miss', reason: 'asset-not-found' })

    const nonHtmlAssets: AssetsFetcher = {
      fetch: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    }
    expect(await fetchStatic404Asset({ assets: nonHtmlAssets, requestUrl: 'https://example.test/x' }))
      .toEqual({ _tag: 'miss', reason: 'non-html-asset' })

    const failure = new Error('assets binding failed')
    const failingAssets: AssetsFetcher = {
      fetch: async () => { throw failure },
    }
    expect(await fetchStatic404Asset({ assets: failingAssets, requestUrl: 'https://example.test/x' }))
      .toEqual({ _tag: 'miss', reason: 'fetch-failed', cause: failure })
  })

  it('follows a single same-origin redirect from ASSETS (e.g. /404.html -> 307 /404)', async () => {
    const redirectCancel = vi.fn(async () => {})
    const assets: AssetsFetcher = {
      fetch: vi.fn(async (input) => {
        const req = input instanceof Request ? input : new Request(input)
        const url = new URL(req.url)
        if (url.pathname === '/404.html') {
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]))
            },
            cancel: redirectCancel,
          })
          return new Response(stream, {
            status: 307,
            headers: { location: '/404' },
          })
        }
        if (url.pathname === '/404') {
          return new Response('<html><body>Redirected Static 404</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }
        return new Response('unexpected', { status: 404 })
      }),
    }

    const result = await fetchStatic404Asset({
      assets,
      requestUrl: 'https://example.test/docs/missing',
      assetPath: '/404.html',
      method: 'GET',
    })

    expect(assets.fetch).toHaveBeenCalledTimes(2)
    expect(redirectCancel).toHaveBeenCalledTimes(1)
    expect(result._tag).toBe('hit')
    if (result._tag !== 'hit')
      return
    expect(result.response.status).toBe(404)
    expect(result.response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    await expect(result.response.text()).resolves.toBe('<html><body>Redirected Static 404</body></html>')
  })

  it('returns miss on cross-origin redirect without following it', async () => {
    const assets: AssetsFetcher = {
      fetch: vi.fn(async () => new Response(null, {
        status: 307,
        headers: { location: 'https://evil.test/404' },
      })),
    }

    const result = await fetchStatic404Asset({
      assets,
      requestUrl: 'https://example.test/docs/missing',
      assetPath: '/404.html',
      method: 'GET',
    })

    expect(assets.fetch).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ _tag: 'miss', reason: 'asset-not-found' })
  })

  it('returns miss on a second redirect (307 -> 307)', async () => {
    const assets: AssetsFetcher = {
      fetch: vi.fn(async (input) => {
        const req = input instanceof Request ? input : new Request(input)
        const nextLocation = new URL(req.url).pathname === '/404.html' ? '/404' : '/404/'
        return new Response(null, {
          status: 307,
          headers: { location: nextLocation },
        })
      }),
    }

    const result = await fetchStatic404Asset({
      assets,
      requestUrl: 'https://example.test/docs/missing',
      assetPath: '/404.html',
      method: 'GET',
    })

    expect(assets.fetch).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ _tag: 'miss', reason: 'asset-not-found' })
  })

  it('cancels a non-null response body when serving a HEAD request', async () => {
    const cancel = vi.fn(async () => {})
    const assets: AssetsFetcher = {
      fetch: vi.fn(async () => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([65]))
          },
          cancel,
        })
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }),
    }

    const result = await fetchStatic404Asset({
      assets,
      requestUrl: 'https://example.test/docs/missing',
      assetPath: '/404.html',
      method: 'HEAD',
    })

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(result._tag).toBe('hit')
    if (result._tag !== 'hit')
      return
    expect(result.response.status).toBe(404)
    expect(result.response.body).toBeNull()
  })
})

describe('wrapNativeFetchWithStatic404 (Nitro 3)', () => {
  it('short-circuits Pass 2 /__nuxt_error SSR with prerendered /404.html', async () => {
    const originalFetch = vi.fn<NativeFetch>(() => new Response('ssr error page', { status: 404 }))
    const assets: AssetsFetcher = {
      fetch: vi.fn(async () => new Response('<h1>Prerendered 404</h1>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })),
    }
    const outer = new Request('https://example.test/docs/missing', {
      method: 'GET',
      headers: { accept: 'text/html' },
    }) as WorkerRequest

    const wrapped = wrapNativeFetchWithStatic404(originalFetch, {
      assetPath: '/404.html',
      enclosingRequest: () => outer,
      resolveAssets: () => assets,
    })

    const response = await wrapped(new Request('https://example.test/__nuxt_error?status=404&url=%2Fdocs%2Fmissing') as WorkerRequest)

    expect(originalFetch).not.toHaveBeenCalled()
    expect(assets.fetch).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(404)
    await expect(response.text()).resolves.toBe('<h1>Prerendered 404</h1>')
  })

  it('falls back to /__nuxt_error SSR for POST requests, JSON requests, 500 errors, or missing /404.html', async () => {
    const originalFetch = vi.fn<NativeFetch>(() => new Response('ssr fallback', { status: 404 }))
    const missingAssets: AssetsFetcher = {
      fetch: vi.fn(async () => new Response('not found', { status: 404 })),
    }

    const postWrapped = wrapNativeFetchWithStatic404(originalFetch, {
      assetPath: '/404.html',
      enclosingRequest: () => new Request('https://example.test/form', { method: 'POST', headers: { accept: 'text/html' } }) as WorkerRequest,
      resolveAssets: () => missingAssets,
    })
    await postWrapped(new Request('https://example.test/__nuxt_error?status=404&url=%2Fform') as WorkerRequest)
    expect(missingAssets.fetch).not.toHaveBeenCalled()
    expect(originalFetch).toHaveBeenCalledTimes(1)

    const missingWrapped = wrapNativeFetchWithStatic404(originalFetch, {
      assetPath: '/404.html',
      enclosingRequest: () => new Request('https://example.test/missing', { method: 'GET', headers: { accept: 'text/html' } }) as WorkerRequest,
      resolveAssets: () => missingAssets,
    })
    const res = await missingWrapped(new Request('https://example.test/__nuxt_error?status=404&url=%2Fmissing') as WorkerRequest)
    expect(missingAssets.fetch).toHaveBeenCalledTimes(1)
    expect(originalFetch).toHaveBeenCalledTimes(2)
    await expect(res.text()).resolves.toBe('ssr fallback')
  })

  it('keeps synchronous non-error responses synchronous', () => {
    const syncResponse = new Response('ok')
    const wrapped = wrapNativeFetchWithStatic404(() => syncResponse, {
      assetPath: '/404.html',
      resolveAssets: () => undefined,
    })

    expect(wrapped(new Request('https://example.test/docs/guide') as WorkerRequest)).toBe(syncResponse)
  })
})

describe('wrapLocalFetchWithStatic404 (Nitro 2)', () => {
  it('intercepts internal /__nuxt_error localFetch and skips SSR when /404.html exists', async () => {
    const originalLocalFetch = vi.fn<LocalFetch>(async () => new Response('ssr error page', { status: 404 }))
    const assets: AssetsFetcher = {
      fetch: vi.fn(async () => new Response('<h1>Static 404</h1>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })),
    }

    const wrapped = wrapLocalFetchWithStatic404(originalLocalFetch, {
      assetPath: '/404.html',
      resolveAssets: () => assets,
    })

    const res = await wrapped('/__nuxt_error?statusCode=404&url=%2Fmissing', {
      headers: { host: 'example.test', accept: 'text/html' },
      context: { nuxt: { '~rendering-error': true } },
    } as never)

    expect(originalLocalFetch).not.toHaveBeenCalled()
    expect(res.status).toBe(404)
    await expect(res.text()).resolves.toBe('<h1>Static 404</h1>')
  })

  it('reports fetch failures through onFetchError and falls back to SSR', async () => {
    const failure = new Error('network error')
    const onFetchError = vi.fn()
    const originalLocalFetch = vi.fn<LocalFetch>(async () => new Response('ssr error page', { status: 404 }))
    const assets: AssetsFetcher = {
      fetch: vi.fn(async () => { throw failure }),
    }

    const wrapped = wrapLocalFetchWithStatic404(originalLocalFetch, {
      assetPath: '/404.html',
      resolveAssets: () => assets,
      onFetchError,
    })

    const res = await wrapped('/__nuxt_error?statusCode=404&url=%2Fmissing', {
      headers: { host: 'example.test', accept: 'text/html' },
      context: { nuxt: { '~rendering-error': true } },
    } as never)

    expect(onFetchError).toHaveBeenCalledWith(failure)
    expect(originalLocalFetch).toHaveBeenCalledTimes(1)
    await expect(res.text()).resolves.toBe('ssr error page')
  })

  it('does not throw on non-error inputs with malformed forwarded headers or protocol-relative inputs', async () => {
    const originalLocalFetch = vi.fn<LocalFetch>(async () => new Response('ok', { status: 200 }))
    const assets: AssetsFetcher = {
      fetch: vi.fn(async () => new Response('<h1>Static 404</h1>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })),
    }

    const wrapped = wrapLocalFetchWithStatic404(originalLocalFetch, {
      assetPath: '/404.html',
      resolveAssets: () => assets,
    })

    await expect(wrapped('/', { headers: { 'x-forwarded-host': 'a.test, b.test' } } as never)).resolves.toBeInstanceOf(Response)
    await expect(wrapped('/', { headers: { 'x-forwarded-proto': 'https, http', 'host': 'example.test' } } as never)).resolves.toBeInstanceOf(Response)
    await expect(wrapped('/', { headers: { 'x-forwarded-host': 'bad host' } } as never)).resolves.toBeInstanceOf(Response)
    await expect(wrapped('//bad host/foo')).resolves.toBeInstanceOf(Response)
    await expect(wrapped('//bad host/__nuxt_error?statusCode=404')).resolves.toBeInstanceOf(Response)

    expect(assets.fetch).not.toHaveBeenCalled()
    expect(originalLocalFetch).toHaveBeenCalledTimes(5)
  })

  it('handles /__nuxt_error with comma-separated or malformed forwarded headers safely', async () => {
    const originalLocalFetch = vi.fn<LocalFetch>(async () => new Response('ssr error page', { status: 404 }))
    const fetchedUrls: string[] = []
    const assets: AssetsFetcher = {
      fetch: vi.fn(async (input) => {
        const req = input instanceof Request ? input : new Request(input)
        fetchedUrls.push(req.url)
        return new Response('<h1>Static 404</h1>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }),
    }

    const wrapped = wrapLocalFetchWithStatic404(originalLocalFetch, {
      assetPath: '/404.html',
      resolveAssets: () => assets,
    })

    const resMulti = await wrapped('/__nuxt_error?statusCode=404&url=%2Fmissing', {
      headers: {
        'x-forwarded-host': 'a.test, b.test',
        'x-forwarded-proto': 'https, http',
        'accept': 'text/html',
      },
      context: { nuxt: { '~rendering-error': true } },
    } as never)

    expect(resMulti.status).toBe(404)
    await expect(resMulti.text()).resolves.toBe('<h1>Static 404</h1>')

    const resMalformed = await wrapped('/__nuxt_error?statusCode=404&url=%2Fmissing', {
      headers: {
        'x-forwarded-host': 'bad host',
        'accept': 'text/html',
      },
      context: { nuxt: { '~rendering-error': true } },
    } as never)

    expect(resMalformed.status).toBe(404)
    await expect(resMalformed.text()).resolves.toBe('<h1>Static 404</h1>')

    expect(originalLocalFetch).not.toHaveBeenCalled()
    expect(fetchedUrls).toEqual(['https://a.test/404.html', 'https://localhost/404.html'])
  })
})
