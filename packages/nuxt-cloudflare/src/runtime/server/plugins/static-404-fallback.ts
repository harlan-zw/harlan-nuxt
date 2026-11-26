import type { LocalFetch, NativeFetch } from '../utils/request-lifetime'
import type { AssetsFetcher, Static404FallbackRuntimeConfig } from '../utils/static-404-fallback'
import { resolveCloudflareBindings } from '@harlan-zw/nuxt-cloudflare/bindings'
import { currentRequest, defineNitroAppPlugin, useRuntimeConfig } from '#nuxt-cloudflare/nitro'
import {
  DEFAULT_STATIC_404_ASSET_PATH,
  wrapLocalFetchWithStatic404,
  wrapNativeFetchWithStatic404,
} from '../utils/static-404-fallback'

let warnedFetchError = false

function warnOnceOnFetchError(assetPath: string, cause: unknown): void {
  if (warnedFetchError)
    return
  warnedFetchError = true
  console.warn(`[nuxt-cloudflare] Failed to fetch prerendered "${assetPath}" from ASSETS; falling back to SSR error page.`, cause)
}

function resolveAssets(source?: unknown): AssetsFetcher | undefined {
  const env = resolveCloudflareBindings<{ ASSETS?: AssetsFetcher }>(source)
  return env?.ASSETS
}

/**
 * Intercepts internal `/__nuxt_error` sub-requests for HTML 404s and serves
 * the prerendered `/404.html` directly from Cloudflare Workers `ASSETS`,
 * avoiding a second Vue SSR pass.
 */
export default defineNitroAppPlugin((nitroApp) => {
  if (import.meta.prerender)
    return

  const config = useRuntimeConfig() as {
    nuxtCloudflare?: { static404Fallback?: Static404FallbackRuntimeConfig }
  }
  const assetPath = config.nuxtCloudflare?.static404Fallback?.assetPath ?? DEFAULT_STATIC_404_ASSET_PATH
  const onFetchError = (cause: unknown) => warnOnceOnFetchError(assetPath, cause)

  const app = nitroApp as { fetch?: NativeFetch, localFetch?: LocalFetch }
  if (typeof app.fetch === 'function') {
    app.fetch = wrapNativeFetchWithStatic404(app.fetch.bind(app), {
      assetPath,
      enclosingRequest: currentRequest,
      resolveAssets,
      onFetchError,
    })
  }
  else if (typeof app.localFetch === 'function') {
    app.localFetch = wrapLocalFetchWithStatic404(app.localFetch, {
      assetPath,
      resolveAssets,
      onFetchError,
    })
  }
})
