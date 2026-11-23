import type { LocalFetch } from '../utils/request-lifetime'
import { defineNitroAppPlugin } from '#nuxt-cloudflare/nitro'
import { keepRequestAlive } from '../utils/request-lifetime'

/**
 * Keeps each Worker request alive until its response settles, so a visitor who
 * leaves cannot strand a promise that later requests share.
 *
 * Nitro's Cloudflare entry reads `nitroApp.localFetch` on every request, so the
 * wrapper must replace it on the app itself. An app without `localFetch`, such
 * as Nitro 3, is left unchanged.
 */
export default defineNitroAppPlugin((nitroApp) => {
  const app = nitroApp as { localFetch?: LocalFetch }
  if (typeof app.localFetch === 'function')
    app.localFetch = keepRequestAlive(app.localFetch)
})
