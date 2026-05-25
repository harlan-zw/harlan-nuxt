// Cache bookkeeping for `useNuxtQuery`. State lives on the Nuxt app instance
// (not module-level) so SSR is safe: each request gets its own cache and there
// is no cross-request leakage in a long-lived Node process. On the client the
// app instance is the SPA lifetime, so behaviour is unchanged from a singleton.
//
// We only track what Nuxt doesn't: per-key `lastFetched` timestamps (for SWR)
// and refcount + GC timers (for `clearNuxtData`-backed payload eviction).
// Active-query tracking and refresh are Nuxt-native — invalidation iterates
// `nuxtApp._asyncData` and calls `refreshNuxtData()`.
//
// Helpers take a `QueryCache` as their first argument so they remain pure
// functions, unit-testable without a Nuxt runtime.

export interface QueryCache {
  /** Last successful real-fetch timestamp per query key. */
  lastFetched: Map<string, number>
  /** Refcount of mounted queries per key — eviction only runs at 0. */
  refCounts: Map<string, number>
  /** Pending GC timers per key, indexed for cancellation on remount. */
  gcTimers: Map<string, ReturnType<typeof setTimeout>>
}

export type QueryStaleTime = number | 'static'

export function createQueryCache(): QueryCache {
  return {
    lastFetched: new Map(),
    refCounts: new Map(),
    gcTimers: new Map(),
  }
}

/** Records that a real network fetch for `key` just completed. */
export function markQueryFetched(cache: QueryCache, key: string, now: number = Date.now()): void {
  cache.lastFetched.set(key, now)
}

/**
 * True when `key` has cached data older than `staleTime`. Mirrors TanStack
 * Query's core stale semantics: `0` is immediately stale, `Infinity` and
 * `'static'` are immutable until invalidated explicitly.
 */
export function isQueryStale(cache: QueryCache, key: string, staleTime: QueryStaleTime, now: number = Date.now()): boolean {
  if (staleTime === 'static' || !Number.isFinite(staleTime))
    return false
  const ts = cache.lastFetched.get(key)
  if (ts == null)
    return true
  return now - ts >= staleTime
}

/**
 * Increment the mount refcount for `key`; cancels a pending GC. Returns a
 * release fn that decrements the count and schedules an eviction after
 * `gcTime` ms when the count hits zero. `gcTime <= 0` disables eviction.
 * The `evict` callback is caller-supplied so this module stays Nuxt-free.
 */
export function retainQuery(
  cache: QueryCache,
  key: string,
  gcTime: number,
  evict: () => void,
): () => void {
  cache.refCounts.set(key, (cache.refCounts.get(key) ?? 0) + 1)
  const pending = cache.gcTimers.get(key)
  if (pending != null) {
    clearTimeout(pending)
    cache.gcTimers.delete(key)
  }
  return () => {
    const next = (cache.refCounts.get(key) ?? 1) - 1
    if (next > 0) {
      cache.refCounts.set(key, next)
      return
    }
    cache.refCounts.delete(key)
    if (gcTime <= 0)
      return
    const timer = setTimeout(() => {
      cache.gcTimers.delete(key)
      cache.lastFetched.delete(key)
      evict()
    }, gcTime)
    cache.gcTimers.set(key, timer)
  }
}

/** Test-only: clears every map between cases. */
export function resetQueryCache(cache: QueryCache): void {
  cache.lastFetched.clear()
  cache.refCounts.clear()
  for (const t of cache.gcTimers.values()) clearTimeout(t)
  cache.gcTimers.clear()
}
