import type { LocalFetch, LocalFetchInit, NativeFetch, WorkerRequest } from './request-lifetime'

export const DEFAULT_STATIC_404_ASSET_PATH = '/404.html'

export interface Static404FallbackOptions {
  /**
   * Path of the prerendered HTML 404 asset inside Cloudflare Workers `ASSETS`.
   * Defaults to `'/404.html'`.
   */
  assetPath?: string
}

export type Static404FallbackPolicy
  = | { _tag: 'disabled' }
    | { _tag: 'enabled', assetPath: string }

export interface Static404FallbackRuntimeConfig {
  assetPath: string
}

export interface AssetsFetcher {
  fetch: (input: Request | string) => Response | Promise<Response>
}

export interface Static404RequestContext {
  /** Pathname of the internal error render request (e.g. `/__nuxt_error`). */
  errorPathname: string
  /** Query parameters carried on the internal error render request. */
  errorSearchParams: URLSearchParams
  /** True when the call originated from Nuxt's error handler rather than a direct visit. */
  isInternalErrorRender: boolean
  /** HTTP method of the visitor request. */
  method: string
  /** Request headers of the visitor request. */
  headers: Headers
  /** Original visitor pathname, when available. */
  originalPathname?: string
}

export type Static404Decision
  = | { _tag: 'serve-static' }
    | {
      _tag: 'pass'
      reason: 'not-error-route' | 'not-internal-render' | 'not-404' | 'unsupported-method' | 'json-or-api-request'
    }

export type Static404FetchResult
  = | { _tag: 'hit', response: Response }
    | { _tag: 'miss', reason: 'no-assets-binding' | 'asset-not-found' | 'non-html-asset' | 'fetch-failed', cause?: unknown }

const HTML_CONTENT_TYPE_RE = /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i

export function resolveStatic404FallbackPolicy(
  input: boolean | Static404FallbackOptions | undefined,
): Static404FallbackPolicy {
  if (!input)
    return { _tag: 'disabled' }

  if (input === true)
    return { _tag: 'enabled', assetPath: DEFAULT_STATIC_404_ASSET_PATH }

  const assetPath = (input.assetPath ?? DEFAULT_STATIC_404_ASSET_PATH).trim()
  if (!assetPath.startsWith('/') || assetPath.includes('..') || assetPath.includes('?') || assetPath.includes('#')) {
    throw new Error(
      `[nuxt-cloudflare] static404Fallback.assetPath must be a root-relative path without query, hash, or traversal segments, received "${assetPath}".`,
    )
  }

  return { _tag: 'enabled', assetPath }
}

export function isNuxtErrorPathname(pathname: string): boolean {
  return pathname === '/__nuxt_error' || pathname.endsWith('/__nuxt_error')
}

function headerIncludes(headers: Headers, name: string, token: string): boolean {
  const value = headers.get(name)
  return Boolean(value && value.toLowerCase().includes(token))
}

function extractOriginalPathname(searchParams: URLSearchParams, fallback?: string): string {
  const raw = searchParams.get('url')
  if (raw) {
    try {
      return new URL(raw, 'https://localhost').pathname
    }
    catch {
      return raw.split('?')[0] || '/'
    }
  }
  return fallback ?? '/'
}

function isJsonOrApiErrorRequest(headers: Headers, pathname: string): boolean {
  if (pathname.startsWith('/api/') || pathname.toLowerCase().endsWith('.json'))
    return true
  if (headerIncludes(headers, 'accept', 'text/html'))
    return false
  return headerIncludes(headers, 'accept', 'application/json')
    || headerIncludes(headers, 'user-agent', 'curl/')
    || headerIncludes(headers, 'user-agent', 'httpie/')
    || headerIncludes(headers, 'sec-fetch-mode', 'cors')
}

export function shouldServeStatic404Fallback(ctx: Static404RequestContext): Static404Decision {
  if (!isNuxtErrorPathname(ctx.errorPathname))
    return { _tag: 'pass', reason: 'not-error-route' }

  if (!ctx.isInternalErrorRender)
    return { _tag: 'pass', reason: 'not-internal-render' }

  const status = ctx.errorSearchParams.get('status') ?? ctx.errorSearchParams.get('statusCode')
  if (status !== '404')
    return { _tag: 'pass', reason: 'not-404' }

  const method = ctx.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD')
    return { _tag: 'pass', reason: 'unsupported-method' }

  const originalPathname = extractOriginalPathname(ctx.errorSearchParams, ctx.originalPathname)
  if (isJsonOrApiErrorRequest(ctx.headers, originalPathname))
    return { _tag: 'pass', reason: 'json-or-api-request' }

  return { _tag: 'serve-static' }
}

export interface FetchStatic404AssetInput {
  assets: AssetsFetcher | undefined
  requestUrl: string
  assetPath?: string
  method?: string
}

export async function fetchStatic404Asset(input: FetchStatic404AssetInput): Promise<Static404FetchResult> {
  if (!input.assets || typeof input.assets.fetch !== 'function')
    return { _tag: 'miss', reason: 'no-assets-binding' }

  const isHead = (input.method ?? 'GET').toUpperCase() === 'HEAD'
  const assetUrl = new URL(input.assetPath ?? DEFAULT_STATIC_404_ASSET_PATH, input.requestUrl)

  let assetResponse: Response
  try {
    assetResponse = await input.assets.fetch(new Request(assetUrl.toString(), { method: isHead ? 'HEAD' : 'GET' }))
  }
  catch (cause) {
    return { _tag: 'miss', reason: 'fetch-failed', cause }
  }

  if (!assetResponse.ok) {
    // Drain/cancel unused body stream so Workers do not warn about leaked responses.
    await assetResponse.body?.cancel().catch(() => undefined)
    return { _tag: 'miss', reason: 'asset-not-found' }
  }

  const contentType = assetResponse.headers.get('content-type')
  if (contentType && !HTML_CONTENT_TYPE_RE.test(contentType)) {
    await assetResponse.body?.cancel().catch(() => undefined)
    return { _tag: 'miss', reason: 'non-html-asset' }
  }

  const headers = new Headers({
    'content-type': contentType || 'text/html; charset=utf-8',
    'cache-control': 'private, no-store',
    'x-robots-tag': assetResponse.headers.get('x-robots-tag') || 'noindex',
  })

  return {
    _tag: 'hit',
    response: new Response(isHead ? null : assetResponse.body, {
      status: 404,
      statusText: 'Not Found',
      headers,
    }),
  }
}

interface InternalErrorRequest extends WorkerRequest {
  context?: {
    nuxt?: Record<string, unknown>
  }
}

export interface WrapNativeStatic404Options {
  assetPath: string
  enclosingRequest?: () => WorkerRequest | undefined
  resolveAssets: (source?: unknown) => AssetsFetcher | undefined
  onFetchError?: (cause: unknown) => void
}

function hasRenderingErrorMarker(context: unknown): boolean {
  if (!context || typeof context !== 'object')
    return false
  const nuxt = (context as { nuxt?: unknown }).nuxt
  if (!nuxt || typeof nuxt !== 'object')
    return false
  return Boolean((nuxt as Record<string, unknown>)['~rendering-error'])
}

export function wrapNativeFetchWithStatic404(
  fetch: NativeFetch,
  options: WrapNativeStatic404Options,
): NativeFetch {
  return (request) => {
    const url = new URL(request.url)
    if (!isNuxtErrorPathname(url.pathname))
      return fetch(request)

    const enclosing = options.enclosingRequest?.()
    const enclosingUrl = enclosing ? new URL(enclosing.url) : undefined
    const isInternalErrorRender = hasRenderingErrorMarker((request as InternalErrorRequest).context)
      || Boolean(enclosingUrl && !isNuxtErrorPathname(enclosingUrl.pathname))

    const visitorMethod = enclosing?.method ?? request.method
    const visitorHeaders = enclosing?.headers ?? request.headers
    const decision = shouldServeStatic404Fallback({
      errorPathname: url.pathname,
      errorSearchParams: url.searchParams,
      isInternalErrorRender,
      method: visitorMethod,
      headers: visitorHeaders,
      originalPathname: enclosingUrl?.pathname,
    })

    if (decision._tag === 'pass')
      return fetch(request)

    const assets = options.resolveAssets(enclosing ?? request)
    if (!assets)
      return fetch(request)

    return fetchStatic404Asset({
      assets,
      requestUrl: enclosing?.url ?? request.url,
      assetPath: options.assetPath,
      method: visitorMethod,
    }).then((result) => {
      if (result._tag === 'hit')
        return result.response
      if (result.reason === 'fetch-failed')
        options.onFetchError?.(result.cause)
      return fetch(request)
    })
  }
}

export interface LocalFetchStatic404Init extends LocalFetchInit {
  headers?: HeadersInit
  method?: string
  context?: LocalFetchInit['context'] & {
    cloudflare?: { env?: Record<string, unknown> }
    nuxt?: Record<string, unknown>
  }
}

export interface WrapLocalStatic404Options {
  assetPath: string
  resolveAssets: (source?: unknown) => AssetsFetcher | undefined
  onFetchError?: (cause: unknown) => void
}

function originFromHeaders(headers: Headers): string {
  const host = headers.get('x-forwarded-host') ?? headers.get('host')
  if (!host)
    return 'https://localhost'
  const proto = headers.get('x-forwarded-proto') ?? 'https'
  return `${proto}://${host}`
}

export function wrapLocalFetchWithStatic404(
  localFetch: LocalFetch,
  options: WrapLocalStatic404Options,
): LocalFetch {
  return async (input, init?: LocalFetchStatic404Init) => {
    const headers = new Headers(init?.headers)
    const requestUrl = new URL(input, originFromHeaders(headers))
    if (!isNuxtErrorPathname(requestUrl.pathname))
      return localFetch(input, init)

    const method = init?.method ?? 'GET'
    const decision = shouldServeStatic404Fallback({
      errorPathname: requestUrl.pathname,
      errorSearchParams: requestUrl.searchParams,
      isInternalErrorRender: hasRenderingErrorMarker(init?.context),
      method,
      headers,
    })

    if (decision._tag === 'pass')
      return localFetch(input, init)

    const assets = options.resolveAssets(init)
    if (!assets)
      return localFetch(input, init)

    const result = await fetchStatic404Asset({
      assets,
      requestUrl: requestUrl.toString(),
      assetPath: options.assetPath,
      method,
    })

    if (result._tag === 'hit')
      return result.response
    if (result.reason === 'fetch-failed')
      options.onFetchError?.(result.cause)
    return localFetch(input, init)
  }
}
