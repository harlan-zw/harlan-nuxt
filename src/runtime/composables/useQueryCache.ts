import type { QueryCache } from '../cache'
import { refreshNuxtData, useNuxtApp } from '#app'
import { createQueryCache, markQueryFetched } from '../cache'
import { listActiveNuxtDataKeys, listPayloadDataKeys, readNuxtData, readQueryMeta, writeNuxtData, writeQueryMeta } from '../nuxt-data'

// Resolve the per-Nuxt-app query cache. Attached lazily to `useNuxtApp()` so
// each SSR request has its own — no shared state across requests in a Node
// worker. On the client the Nuxt app is the SPA lifetime, so the cache lives
// for the session.

const CACHE_KEY = '_nuxtQueryCache' as const

// eslint-disable-next-line harlanzw/vue-no-faux-composables -- Nuxt composable, reads `useNuxtApp()`
export function useQueryCache(): QueryCache {
  const nuxt = useNuxtApp() as unknown as Record<string, unknown>
  let cache = nuxt[CACHE_KEY] as QueryCache | undefined
  if (cache == null) {
    cache = createQueryCache()
    nuxt[CACHE_KEY] = cache
    // Only on the client (SSR builds the payload it reads), and only at first
    // creation so a later `markQueryFetched` is never clobbered.
    if (import.meta.client)
      seedCacheFromPayload(cache, nuxt)
  }
  return cache
}

/**
 * Seed `lastFetched` from the SSR payload at hydration. The timestamp map
 * isn't serialized across SSR→client, so without this every SSR-populated
 * query reads as stale on first client mount and refetches data the payload
 * already holds — `getCachedData` returns `undefined` and `useFetch` hits the
 * network again. Stamping each payload key with the hydration moment makes
 * `isQueryStale` honour each query's `staleTime` against the server's data, so
 * `getCachedData` serves the payload instead. `staleTime: 0` queries still
 * refetch (now − now ≥ 0), matching TanStack's always-stale default.
 *
 * Prefers the server's exact per-key fetch timestamp (stashed in the payload by
 * `serializeQueryCacheToPayload`) so a short `staleTime` isn't fooled by the
 * SSR→hydration gap; falls back to `now` for any key without a recorded stamp.
 */
export function seedCacheFromPayload(cache: QueryCache, nuxt: unknown, now: number = Date.now()): void {
  const meta = readQueryMeta(nuxt)
  for (const key of listPayloadDataKeys(nuxt))
    markQueryFetched(cache, key, meta?.[key] ?? now)
}

/**
 * Serialize the per-request `lastFetched` map into the payload so the client
 * can seed exact timestamps. Called from the server render hook; a no-op when
 * the cache was never created (no queries ran).
 */
export function serializeQueryCacheToPayload(nuxt: unknown): void {
  const cache = (nuxt as Record<string, unknown>)[CACHE_KEY] as QueryCache | undefined
  if (cache == null || cache.lastFetched.size === 0)
    return
  writeQueryMeta(nuxt, Object.fromEntries(cache.lastFetched))
}

/**
 * Invalidate cached queries by key prefix. Reads the active keys from Nuxt's
 * own async-data registry and delegates the refresh to `refreshNuxtData(keys)`.
 * Drops `lastFetched` timestamps so the next SWR check sees the queries as
 * stale. No-prefix form invalidates every active key.
 *
 * This is the Nuxt-primitive replacement for a hand-rolled refresh registry:
 * Nuxt already tracks every keyed `useFetch` / `useAsyncData`, so we ride that.
 */
// eslint-disable-next-line harlanzw/vue-require-composable-prefix -- imperative helper, no reactivity of its own
export function invalidateNuxtQueries(prefix?: string | ((key: string) => boolean)): void {
  const cache = useQueryCache()
  const nuxt = useNuxtApp()
  const matches = typeof prefix === 'function'
    ? prefix
    : (k: string) => !prefix || k.startsWith(prefix)
  const keys = listActiveNuxtDataKeys(nuxt).filter(matches)
  for (const k of keys)
    cache.lastFetched.delete(k)
  if (keys.length > 0)
    void refreshNuxtData(keys)
}

/**
 * Read the current cached value for `key`. Same fallback chain as Nuxt's own
 * `useNuxtData(key)` (live `_asyncData` ref → `payload.data` → `static.data`).
 */
export function getQueryData<T = unknown>(key: string): T | undefined {
  return readNuxtData<T>(useNuxtApp(), key)
}

/**
 * Write directly to the cached value for `key`. `updater` is either the next
 * value, or a `(previous) => next` function. Returns the previous value so
 * the caller can hand it back to `setQueryData(key, previous)` on rollback.
 *
 * Mirrors TanStack Query's `setQueryData`. Updates BOTH stores Nuxt reads —
 * see `nuxt-data.ts` for why the dual-write is load-bearing. The
 * `lastFetched` timestamp is bumped so SWR treats the write as a fresh fetch
 * and doesn't immediately overwrite it with a network refresh.
 */
// eslint-disable-next-line harlanzw/vue-require-composable-prefix -- imperative helper
export function setQueryData<T = unknown>(
  key: string,
  updater: T | ((previous: T | undefined) => T),
): T | undefined {
  const cache = useQueryCache()
  const nuxt = useNuxtApp()
  const previous = readNuxtData<T>(nuxt, key)
  const next = typeof updater === 'function'
    ? (updater as (p: T | undefined) => T)(previous)
    : updater
  writeNuxtData(nuxt, key, next)
  cache.lastFetched.set(key, Date.now())
  return previous
}
