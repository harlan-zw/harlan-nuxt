import { defineNuxtPlugin } from '#app'
import { serializeQueryCacheToPayload } from './query-cache-hydration'

// At the end of the server render, stash the per-request `lastFetched` map into
// the payload. The client's `seedCacheFromPayload` reads it back lazily when the
// cache is first resolved.
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.hook('app:rendered', () => {
    serializeQueryCacheToPayload(nuxtApp)
  })
})
