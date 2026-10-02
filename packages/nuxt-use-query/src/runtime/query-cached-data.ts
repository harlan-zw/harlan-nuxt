import type { NuxtApp } from 'nuxt/app'
import type { QueryCache, QueryStaleTime } from './cache'
import { isQueryStale } from './cache'
import { readNuxtData } from './nuxt-data'
import { isQuerySsrDeferredPayload } from './query-server-option'

/** The `getCachedData` contract shared by `useFetch` and `useAsyncData`. */
export type QueryGetCachedData = (key: string, nuxtApp: NuxtApp, context: { cause: string }) => unknown

/**
 * The `getCachedData` policy every query primitive hands to Nuxt, so
 * `useNuxtQuery` and `useNuxtAsyncQuery` cannot drift apart.
 */
export function createQueryGetCachedData(
  cache: QueryCache,
  staleTime: QueryStaleTime,
  custom?: QueryGetCachedData,
): QueryGetCachedData {
  return (cacheKey, nuxtApp, context) => {
    // Explicit refresh must read the source, even while cached data is fresh.
    if (context.cause === 'refresh:manual' || context.cause === 'refresh:hook')
      return undefined

    if (custom) {
      const cached = custom(cacheKey, nuxtApp, context)
      if (cached !== undefined && !isQuerySsrDeferredPayload(cached))
        return cached
    }
    // Hydration renders the server's data whatever its age, so the first
    // client render matches the server markup. Nuxt's own default also reads
    // the payload while hydrating. A stale query then refetches on mount
    // through the query lifecycle.
    if (!nuxtApp.isHydrating && isQueryStale(cache, cacheKey, staleTime))
      return undefined
    const cached = readNuxtData(nuxtApp, cacheKey)
    return isQuerySsrDeferredPayload(cached) ? undefined : cached
  }
}
