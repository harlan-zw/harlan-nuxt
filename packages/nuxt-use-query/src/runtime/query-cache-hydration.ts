import type { QueryCache } from './cache'
import { createQueryCache, markQueryFetched } from './cache'
import { listPayloadDataKeys, readQueryMeta, writeQueryMeta } from './nuxt-data'

export const QUERY_CACHE_KEY = '_nuxtQueryCache' as const

export function resolveQueryCache(nuxt: Record<string, unknown>, seedFromPayload: boolean): QueryCache {
  let cache = nuxt[QUERY_CACHE_KEY] as QueryCache | undefined
  if (cache == null) {
    cache = createQueryCache()
    nuxt[QUERY_CACHE_KEY] = cache
    if (seedFromPayload)
      seedCacheFromPayload(cache, nuxt)
  }
  return cache
}

/**
 * Seed `lastFetched` from the SSR payload at hydration. The timestamp map
 * isn't serialized across SSR→client, so without this every SSR-populated
 * query reads as stale on first client mount and refetches data the payload
 * already holds.
 */
export function seedCacheFromPayload(cache: QueryCache, nuxt: unknown, now: number = Date.now()): void {
  const meta = readQueryMeta(nuxt)
  for (const key of listPayloadDataKeys(nuxt))
    markQueryFetched(cache, key, meta?.[key] ?? now)
}

/**
 * Serialize the per-request `lastFetched` map into the payload so the client
 * can seed exact timestamps. Called from the server render hook; a no-op when
 * the cache was never created.
 */
export function serializeQueryCacheToPayload(nuxt: unknown): void {
  const cache = (nuxt as Record<string, unknown>)[QUERY_CACHE_KEY] as QueryCache | undefined
  if (cache == null || cache.lastFetched.size === 0)
    return
  writeQueryMeta(nuxt, Object.fromEntries(cache.lastFetched))
}
