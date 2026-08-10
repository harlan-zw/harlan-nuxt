import { createQueryCache, isQueryStale } from '@harlanzw/nuxt-use-query/cache'
import { describe, expect, it } from 'vitest'
import { seedCacheFromPayload } from '../src/runtime/query-cache-hydration'

// Regression: the `lastFetched` timestamp map lives on the per-Nuxt-app cache
// and is NOT serialized across SSR → client. Without seeding it from the
// payload at hydration, every SSR-populated query reads as stale on first
// client mount and refetches data the payload already holds (the redundant
// post-hydration fetch). `seedCacheFromPayload` is the fix; these assert it
// makes `isQueryStale` honour `staleTime` against the hydrated keys.

function fakeNuxt(dataKeys: Record<string, unknown>) {
  return { payload: { data: dataKeys } }
}

describe('seedCacheFromPayload (hydration)', () => {
  it('stamps every payload key so a staleTime-windowed query is fresh after hydration', () => {
    const cache = createQueryCache()
    const nuxt = fakeNuxt({ 'pro:sites': { sites: [] }, 'pro:groups': { groups: [] } })

    // Before seeding: no timestamp → stale → would refetch the SSR data.
    expect(isQueryStale(cache, 'pro:sites', 60_000, 1_000)).toBe(true)

    seedCacheFromPayload(cache, nuxt, 1_000)

    // After seeding: within the 60s window → fresh → getCachedData serves payload.
    expect(isQueryStale(cache, 'pro:sites', 60_000, 1_000 + 30_000)).toBe(false)
    expect(isQueryStale(cache, 'pro:groups', 60_000, 1_000 + 30_000)).toBe(false)
    // Beyond the window it correctly goes stale again.
    expect(isQueryStale(cache, 'pro:sites', 60_000, 1_000 + 90_000)).toBe(true)
  })

  it('leaves staleTime: 0 queries stale (TanStack always-stale default)', () => {
    const cache = createQueryCache()
    seedCacheFromPayload(cache, fakeNuxt({ q: { x: 1 } }), 1_000)
    // now − stampedAt = 0 ≥ 0 → stale, so a staleTime:0 query still refetches.
    expect(isQueryStale(cache, 'q', 0, 1_000)).toBe(true)
  })

  it('does not stamp keys absent from the payload', () => {
    const cache = createQueryCache()
    seedCacheFromPayload(cache, fakeNuxt({ present: 1 }), 1_000)
    expect(cache.lastFetched.has('present')).toBe(true)
    expect(cache.lastFetched.has('missing')).toBe(false)
  })

  it('tolerates an empty / absent payload data store', () => {
    const cache = createQueryCache()
    expect(() => seedCacheFromPayload(cache, { payload: {} }, 1_000)).not.toThrow()
    expect(cache.lastFetched.size).toBe(0)
  })

  it('prefers the server-serialized exact timestamp over the hydration moment', () => {
    const cache = createQueryCache()
    // Server fetched at t=1_000 and stashed it in payload.nuxtQueryMeta; client
    // hydrates at t=4_000. Seeding must use 1_000, not 4_000, so a short
    // staleTime measures from the real fetch time.
    const nuxt = { payload: { data: { q: { x: 1 } }, nuxtQueryMeta: { q: 1_000 } } }
    seedCacheFromPayload(cache, nuxt, 4_000)
    expect(cache.lastFetched.get('q')).toBe(1_000)
    // With a 2s staleTime the data fetched at 1_000 is already stale at 4_000…
    expect(isQueryStale(cache, 'q', 2_000, 4_000)).toBe(true)
    // …whereas the naive hydration-time seed (4_000) would have wrongly read fresh.
  })

  it('falls back to the hydration moment for keys without a serialized stamp', () => {
    const cache = createQueryCache()
    const nuxt = { payload: { data: { a: 1, b: 2 }, nuxtQueryMeta: { a: 1_000 } } }
    seedCacheFromPayload(cache, nuxt, 4_000)
    expect(cache.lastFetched.get('a')).toBe(1_000)
    expect(cache.lastFetched.get('b')).toBe(4_000)
  })

  it('also seeds prerendered / payload-extracted keys from static.data', () => {
    const cache = createQueryCache()
    // Prerendered pages hydrate from `static.data`, not `payload.data` — mirror
    // readNuxtData's fallback so those keys are seeded too.
    const nuxt = { payload: { data: { ssrKey: 1 } }, static: { data: { prerenderedKey: 2 } } }
    seedCacheFromPayload(cache, nuxt, 1_000)
    expect(cache.lastFetched.has('ssrKey')).toBe(true)
    expect(cache.lastFetched.has('prerenderedKey')).toBe(true)
  })
})
