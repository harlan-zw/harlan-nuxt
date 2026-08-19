import type { H3Event } from 'h3'
import type { DocumentCacheDecision, HtmlCacheMode } from '../utils/workers-cache'
import { getHeader, getResponseHeader, getResponseStatus, setResponseHeader } from 'h3'
import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime'
import {
  clampSharedCacheSeconds,
  documentCacheDecision,
  NO_STORE_BROWSER,
  NO_STORE_EDGE,
  resolveHtmlCacheGuarantee,
} from '../utils/workers-cache'

/**
 * One line per route per isolate. A cache decision repeats on every request,
 * and a warning that repeats is a warning nobody reads.
 */
const warned = new Set<string>()

function warnOnce(route: string, message: string): void {
  if (warned.has(route))
    return
  warned.add(route)
  console.warn(`[nuxt-cloudflare] ${message}`)
}

function isAuthenticated(event: H3Event): boolean {
  return Boolean(
    getHeader(event, 'cookie')
    || getHeader(event, 'authorization')
    || getHeader(event, 'proxy-authorization'),
  )
}

export default defineNitroPlugin((nitroApp) => {
  // The floor, before routing. Workers Cache treats a headerless 200 as
  // cacheable for two hours, so every response needs a policy, including the
  // ones that never reach `beforeResponse`: nitro's error renderer calls
  // `send()` directly, which marks the event handled and skips that hook
  // entirely. A floor set here is the only thing an error response inherits.
  nitroApp.hooks.hook('request', (event: H3Event) => {
    // Only the browser header. Cloudflare reads
    // `Cloudflare-CDN-Cache-Control` ahead of `Cache-Control` and falls back to
    // it when absent, so `private, no-store` here already closes the edge.
    //
    // Setting the edge header too would defeat the whole change: an app that
    // writes `cache-control: public, s-maxage=300` and nothing else would be
    // honoured, then overruled by our own floor sitting in the
    // higher-precedence header, and the route rule would still do nothing.
    // Leaving that header untouched also means its presence later can only
    // mean the app set it, so there is no need to tell our value from theirs.
    setResponseHeader(event, 'cache-control', NO_STORE_BROWSER)
  })

  // Deliberately no `render:response` hook. That hook is handed a plain headers
  // object with no event, so it cannot see what a route rule set, and the
  // previous version overwrote unconditionally for exactly that reason.

  nitroApp.hooks.hook('beforeResponse', (event: H3Event) => {
    const config = useRuntimeConfig(event)
    const mode = (config.nuxtCloudflare?.htmlCacheMode ?? 'auto') as HtmlCacheMode
    const guarantee = resolveHtmlCacheGuarantee(config.htmlCacheCapabilities)
    // The edge header outranks the browser one for this decision, because it is
    // the one addressed to the cache doing the storing. An app that puts the
    // real lifetime on `cloudflare-cdn-cache-control` and `max-age=0` on
    // `cache-control` has still asked for shared caching, and reading only the
    // browser header would discard that as a refusal.
    // Present only if the app set it, because the floor no longer writes here.
    const stated = getResponseHeader(event, 'cloudflare-cdn-cache-control')
      ?? getResponseHeader(event, 'cdn-cache-control')
    const browserHeader = getResponseHeader(event, 'cache-control')
    const cacheControl = stated
      ?? (browserHeader === NO_STORE_BROWSER ? undefined : browserHeader)

    // The floor is already on the response, so anything that still reads as
    // no-store is either ours or the app agreeing with us.
    const decision: DocumentCacheDecision = documentCacheDecision({
      mode,
      guarantee,
      cacheControl,
      status: getResponseStatus(event),
      authenticated: isAuthenticated(event),
    })

    if (decision._tag === 'honour')
      return

    if (decision._tag === 'floor') {
      setResponseHeader(event, 'cache-control', NO_STORE_BROWSER)
      setResponseHeader(event, 'cloudflare-cdn-cache-control', NO_STORE_EDGE)
      return
    }

    if (decision._tag === 'clamp') {
      // Lower whichever header carried the lifetime and leave the other as the
      // app wrote it. Rewriting both would invent a browser policy the app
      // never asked for.
      const target = stated ? 'cloudflare-cdn-cache-control' : 'cache-control'
      setResponseHeader(event, target, clampSharedCacheSeconds(String(cacheControl), decision.toSeconds))
      warnOnce(
        `clamp:${event.path}`,
        `Route ${event.path} asked to be cached for ${decision.fromSeconds}s. ${decision.by} covers ${decision.toSeconds}s. The value was lowered.`,
      )
      return
    }

    // The only outcome that took something the app asked for. Say what was
    // taken, and say how to keep it.
    warnOnce(
      `override:${event.path}`,
      `The response for ${event.path} set \`cache-control: ${String(cacheControl)}\`. Workers Cache replaced it because ${decision.reason}. To keep your value, set \`nuxtCloudflare.workersCache.html: 'app'\`.`,
    )
    setResponseHeader(event, 'cache-control', NO_STORE_BROWSER)
    setResponseHeader(event, 'cloudflare-cdn-cache-control', NO_STORE_EDGE)
  })
})
