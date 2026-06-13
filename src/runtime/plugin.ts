import { defineNuxtPlugin } from '#app'
import { serializeQueryCacheToPayload } from './composables/useQueryCache'

// Server-only: at the end of the render, stash the per-request `lastFetched`
// map into the payload. The client's `seedCacheFromPayload` reads it back so
// SSR-populated queries are seeded with their ACTUAL fetch time rather than the
// hydration moment — the difference only matters when `staleTime` is shorter
// than the SSR→hydration gap, but it keeps the SWR clock honest. Client-side
// this plugin does nothing (the seed runs lazily at cache creation instead).
export default defineNuxtPlugin((nuxtApp) => {
  if (!import.meta.server)
    return
  nuxtApp.hook('app:rendered', () => {
    serializeQueryCacheToPayload(nuxtApp)
  })
})
