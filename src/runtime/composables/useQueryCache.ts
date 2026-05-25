import type { QueryCache } from '../cache'
import { refreshNuxtData, useNuxtApp } from '#app'
import { createQueryCache } from '../cache'
import { listActiveNuxtDataKeys, readNuxtData, writeNuxtData } from '../nuxt-data'

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
  }
  return cache
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
