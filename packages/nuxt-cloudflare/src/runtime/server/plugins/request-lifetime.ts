import type { LocalFetch, NativeFetch } from '../utils/request-lifetime'
import { defineNitroAppPlugin } from '#nuxt-cloudflare/nitro'
import { keepNativeRequestAlive, keepRequestAlive } from '../utils/request-lifetime'

/**
 * Keeps each Worker request alive until its response settles, so a visitor who
 * leaves cannot strand a promise that later requests share.
 *
 * The Cloudflare entry calls the app's `fetch` on Nitro 3 and `localFetch` on Nitro 2.
 */
export default defineNitroAppPlugin((nitroApp) => {
  const app = nitroApp as { fetch?: NativeFetch, localFetch?: LocalFetch }
  if (typeof app.fetch === 'function')
    app.fetch = keepNativeRequestAlive(app.fetch.bind(app))
  else if (typeof app.localFetch === 'function')
    app.localFetch = keepRequestAlive(app.localFetch)
})
