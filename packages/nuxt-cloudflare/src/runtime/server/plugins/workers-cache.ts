import type { H3Event } from 'h3'
import type { CacheDecision, HtmlCacheMode } from '../utils/workers-cache'
import { getHeader, getResponseHeader, getResponseStatus, setResponseHeader } from 'h3'
import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime'
import {
  clampSharedCacheSeconds,
  NO_STORE_BROWSER,
  NO_STORE_EDGE,
  resolveHtmlCacheGuarantee,
  responseCacheDecision,
  sharedCacheSeconds,
  statedPolicy,
} from '../utils/workers-cache'

/**
 * One warning per route per isolate, bounded.
 *
 * Keyed on the pathname with the query removed, because `event.path` carries
 * it: `?ref=1` and `?ref=2` are the same route and used to be two warnings, on
 * a registry with an unbounded supply of query strings. The cap stops a
 * long-lived isolate accumulating keys for every path it ever served.
 */
const warned = new Set<string>()
const WARN_LIMIT = 200

function warnOnce(kind: string, path: string, message: string): void {
  const key = `${kind}:${path.split('?')[0]}`
  if (warned.has(key))
    return
  if (warned.size >= WARN_LIMIT)
    return
  warned.add(key)
  console.warn(`[nuxt-cloudflare] ${message}`)
}

/**
 * Credentials that personalise a response without being a session cookie.
 *
 * Cloudflare Access service tokens and plain API keys both authenticate a
 * request while leaving `Authorization` empty, so a check on that header alone
 * would publish an authenticated document to a shared cache.
 */
const CREDENTIAL_HEADERS = [
  'cookie',
  'authorization',
  'proxy-authorization',
  'cf-access-jwt-assertion',
  'cf-access-client-id',
  'x-api-key',
] as const

function isAuthenticated(event: H3Event): boolean {
  return CREDENTIAL_HEADERS.some(name => Boolean(getHeader(event, name)))
}

const DOCUMENT_TYPE_RE = /^(?:text\/html|application\/xhtml\+xml)\s*(?:;|$)/i

function isDocumentResponse(event: H3Event): boolean {
  const type = getResponseHeader(event, 'content-type')
  return typeof type === 'string' && DOCUMENT_TYPE_RE.test(type)
}

export default defineNitroPlugin((nitroApp) => {
  // The floor, before routing. Workers Cache treats a headerless 200 as
  // cacheable for two hours, so every response needs a policy, including the
  // ones that never reach `beforeResponse`: nitro's error renderer and
  // `sendRedirect` both call `send()`, which marks the event handled and skips
  // that hook. A floor set here is the only thing they inherit.
  //
  // Only the browser header. Cloudflare reads `Cloudflare-CDN-Cache-Control`
  // ahead of `Cache-Control` and falls back to it when absent, so this already
  // closes the edge. Writing the edge header too would defeat the whole change:
  // a route rule setting only `cache-control` would be honoured and then
  // overruled by our own value in the higher-precedence header. Leaving it
  // untouched also means its presence later can only mean the app set it.
  nitroApp.hooks.hook('request', (event: H3Event) => {
    setResponseHeader(event, 'cache-control', NO_STORE_BROWSER)
  })

  // Deliberately no `render:response` hook. That hook is handed a plain headers
  // object with no event, so it cannot see what a route rule set, and the
  // previous version overwrote unconditionally for exactly that reason.

  nitroApp.hooks.hook('beforeResponse', (event: H3Event) => {
    const config = useRuntimeConfig(event)
    const mode = (config.nuxtCloudflare?.htmlCacheMode ?? 'auto') as HtmlCacheMode

    const edge = getResponseHeader(event, 'cloudflare-cdn-cache-control')
      ?? getResponseHeader(event, 'cdn-cache-control')
    const browser = getResponseHeader(event, 'cache-control')
    // The floor is ours, so a response still carrying it has said nothing.
    const appBrowser = browser === NO_STORE_BROWSER ? undefined : browser
    const carrier = edge ?? appBrowser

    const decision: CacheDecision = responseCacheDecision({
      mode,
      guarantee: resolveHtmlCacheGuarantee(config.htmlCacheCapabilities),
      isDocument: isDocumentResponse(event),
      stated: statedPolicy(name => (name === 'cache-control' ? appBrowser : getResponseHeader(event, name))),
      requestedSeconds: sharedCacheSeconds(carrier),
      status: getResponseStatus(event),
      authenticated: isAuthenticated(event),
      setsCookie: Boolean(getResponseHeader(event, 'set-cookie')),
      vary: getResponseHeader(event, 'vary') as string | undefined,
    })

    if (decision._tag === 'leave')
      return

    if (decision._tag === 'floor') {
      setResponseHeader(event, 'cache-control', NO_STORE_BROWSER)
      setResponseHeader(event, 'cloudflare-cdn-cache-control', NO_STORE_EDGE)
      return
    }

    if (decision._tag === 'clamp') {
      // Lower every header that carries a lifetime. Rewriting only the one the
      // decision read would leave the other over-long, and the browser header
      // is the one reaching caches that never learn about a deploy.
      if (edge) {
        setResponseHeader(event, 'cloudflare-cdn-cache-control', clampSharedCacheSeconds(String(edge), decision.toSeconds))
      }
      if (appBrowser) {
        setResponseHeader(event, 'cache-control', clampSharedCacheSeconds(String(appBrowser), decision.toSeconds))
      }
      warnOnce(
        'clamp',
        event.path,
        `Route ${event.path.split('?')[0]} asked to be cached for ${decision.fromSeconds}s. ${decision.by} covers ${decision.toSeconds}s. The value was lowered.`,
      )
      return
    }

    // The only outcome that took something the app asked for. Say what was
    // taken, and say how to keep it.
    warnOnce(
      'override',
      event.path,
      `The response for ${event.path.split('?')[0]} set \`cache-control: ${String(carrier)}\`. Workers Cache replaced it because ${decision.reason}. To keep your value, set \`nuxtCloudflare.workersCache.html: 'app'\`.`,
    )
    setResponseHeader(event, 'cache-control', NO_STORE_BROWSER)
    setResponseHeader(event, 'cloudflare-cdn-cache-control', NO_STORE_EDGE)
  })
})
