/**
 * Cache headers for a Cloudflare route rule.
 *
 * Written for `nuxt.config.ts`, so it is a pure value producer with no runtime
 * and no side effects. It returns the same plain literal you would write by
 * hand, which means the module's build validator and its `beforeResponse`
 * contract see exactly what they would have seen anyway. There is no marker, no
 * exemption, and no second source of truth.
 *
 * ```ts
 * routeRules: {
 *   '/api/feed': edgeCache({ maxAge: 60 }),
 *   '/api/reports': edgeCache({ maxAge: 3600, staleWhileRevalidate: 86400, browser: 'revalidate' }),
 *   '/api/private': NO_STORE,
 * }
 * ```
 *
 * The reason it exists is one rule that is easy to get wrong and silent when
 * you do: **never emit `s-maxage`**. Cloudflare reads it as implying
 * `proxy-revalidate`, which disables `stale-while-revalidate` and
 * `stale-if-error` outright, so a policy that looks like it serves stale
 * quietly blocks on revalidation instead. Three separate sites hand-wrote this
 * pattern and all three left a comment about the same trap.
 */

export interface EdgeCacheOptions {
  /**
   * Seconds a shared cache serves this without revalidating.
   *
   * Emitted as `max-age`, never `s-maxage`, for the reason above. Cloudflare
   * falls back to `max-age` for the edge when `s-maxage` is absent, so this
   * bounds the edge either way.
   */
  maxAge: number
  /** Seconds a stale copy may be served while a fresh one is fetched behind it. */
  staleWhileRevalidate?: number
  /** Seconds a stale copy may be served while the origin is failing. */
  staleIfError?: number
  /**
   * What browsers get.
   *
   * - `'no-store'` (default) emits no `cache-control`, so the module's own
   *   fail-closed floor stands and only the edge caches.
   * - `'revalidate'` emits `public, max-age=0`, so a browser always asks but
   *   the edge usually answers.
   * - `{ maxAge }` gives browsers a real lifetime of their own.
   */
  browser?: 'no-store' | 'revalidate' | { maxAge: number, immutable?: boolean }
  /**
   * Append `private="set-cookie"`.
   *
   * A qualified `private` names the fields a shared cache must drop rather than
   * refusing the response, so a response that sets a cookie is still storable
   * with the cookie stripped from the stored copy. Without it, any `Set-Cookie`
   * makes the response unstorable.
   */
  dropSetCookie?: boolean
}

export interface EdgeCacheRule {
  headers: Record<string, string>
}

/** Never stored anywhere. The explicit form of the module's default. */
export const NO_STORE: EdgeCacheRule = {
  headers: { 'cache-control': 'private, no-store' },
}

function directives(parts: (string | false | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(', ')
}

export function edgeCache(options: EdgeCacheOptions): EdgeCacheRule {
  if (!Number.isFinite(options.maxAge) || options.maxAge <= 0) {
    throw new Error(
      `[nuxt-cloudflare] edgeCache needs a positive maxAge, received ${options.maxAge}. Use NO_STORE for a route that must never be cached.`,
    )
  }

  const qualified = options.dropSetCookie ? 'private="set-cookie"' : undefined

  const edge = directives([
    'public',
    `max-age=${Math.floor(options.maxAge)}`,
    options.staleWhileRevalidate ? `stale-while-revalidate=${Math.floor(options.staleWhileRevalidate)}` : undefined,
    options.staleIfError ? `stale-if-error=${Math.floor(options.staleIfError)}` : undefined,
    qualified,
  ])

  const headers: Record<string, string> = { 'cloudflare-cdn-cache-control': edge }

  const browser = options.browser ?? 'no-store'
  if (browser === 'revalidate') {
    headers['cache-control'] = directives(['public', 'max-age=0', qualified])
  }
  else if (typeof browser === 'object') {
    if (!Number.isFinite(browser.maxAge) || browser.maxAge < 0)
      throw new Error(`[nuxt-cloudflare] edgeCache browser.maxAge must be zero or more, received ${browser.maxAge}.`)
    headers['cache-control'] = directives([
      'public',
      `max-age=${Math.floor(browser.maxAge)}`,
      browser.immutable ? 'immutable' : undefined,
      qualified,
    ])
  }

  return { headers }
}
