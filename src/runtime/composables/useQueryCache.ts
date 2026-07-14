import type { QueryCache } from '../cache'
import { clearNuxtData, refreshNuxtData, useNuxtApp } from '#app'
import {
  listActiveNuxtDataKeys,
  listNuxtDataKeys,
  readNuxtData,
  readNuxtDataRefreshFailures,
  readQueryMeta,
  removeNuxtDataArtifacts,
  writeNuxtData,
} from '../nuxt-data'
import { resolveQueryCache } from '../query-cache-hydration'

// Resolve the per-Nuxt-app query cache. Attached lazily to `useNuxtApp()` so
// each SSR request has its own — no shared state across requests in a Node
// worker. On the client the Nuxt app is the SPA lifetime, so the cache lives
// for the session.

// eslint-disable-next-line harlanzw/vue-no-faux-composables -- Nuxt composable, reads `useNuxtApp()`
export function useQueryCache(): QueryCache {
  const nuxt = useNuxtApp() as unknown as Record<string, unknown>
  // Only on the client (SSR builds the payload it reads), and only at first
  // creation so a later `markQueryFetched` is never clobbered.
  return resolveQueryCache(nuxt, import.meta.client)
}

/**
 * Invalidate cached queries by key prefix. Reads the active keys from Nuxt's
 * own async-data registry and delegates the refresh to `refreshNuxtData(keys)`.
 * Drops `lastFetched` timestamps so the next SWR check sees the queries as
 * stale. No-prefix form invalidates every active key.
 *
 * The returned Promise settles after every matched active refresh. Nuxt parks
 * HTTP failures in async-data state while resolving `refreshNuxtData`; this
 * helper converts that state into a `NuxtQueryRefreshError` rejection.
 *
 * This is the Nuxt-primitive replacement for a hand-rolled refresh registry:
 * Nuxt already tracks every keyed `useFetch` / `useAsyncData`, so we ride that.
 */
export type NuxtQueryMatcher = string | ((key: string) => boolean)

/** One or more matched active queries ended their awaited refresh in error. */
export class NuxtQueryRefreshError extends Error {
  readonly failures: ReturnType<typeof readNuxtDataRefreshFailures>

  constructor(failures: ReturnType<typeof readNuxtDataRefreshFailures>) {
    super(`Failed to refresh ${failures.length} active ${failures.length === 1 ? 'query' : 'queries'}.`)
    this.name = 'NuxtQueryRefreshError'
    this.failures = failures
  }
}

function resolveMatcher(matcher?: NuxtQueryMatcher): (key: string) => boolean {
  return typeof matcher === 'function'
    ? matcher
    : (key: string) => !matcher || key.startsWith(matcher)
}

// eslint-disable-next-line harlanzw/vue-require-composable-prefix -- imperative helper, no reactivity of its own
export async function invalidateNuxtQueries(prefix?: NuxtQueryMatcher): Promise<void> {
  const cache = useQueryCache()
  const nuxt = useNuxtApp()
  const matches = resolveMatcher(prefix)
  const keys = listActiveNuxtDataKeys(nuxt).filter(matches)
  for (const k of cache.lastFetched.keys()) {
    if (matches(k))
      cache.lastFetched.delete(k)
  }
  if (keys.length === 0)
    return
  await refreshNuxtData(keys)
  // Nuxt's refresh promise resolves after a failed useAsyncData execution and
  // parks the failure in the entry. Turn that stored state back into a rejected
  // effect promise so realtime ACK/cursor callers cannot report false freshness.
  const failures = readNuxtDataRefreshFailures(nuxt, keys)
  if (failures.length > 0)
    throw new NuxtQueryRefreshError(failures)
}

/**
 * Remove matching query data and freshness metadata without refetching. This is
 * the safe primitive for logout/access-context changes: invalidating an old
 * namespace could otherwise refetch it with a new credential.
 */
// eslint-disable-next-line harlanzw/vue-require-composable-prefix -- imperative helper
export function removeNuxtQueries(prefix?: NuxtQueryMatcher): void {
  const cache = useQueryCache()
  const nuxt = useNuxtApp()
  const matches = resolveMatcher(prefix)
  const candidates = new Set([
    ...listNuxtDataKeys(nuxt),
    ...cache.lastFetched.keys(),
    ...cache.gcTimers.keys(),
    ...Object.keys(readQueryMeta(nuxt) ?? {}),
  ])
  const keys = [...candidates].filter(matches)
  if (keys.length === 0)
    return

  // Explicit keys include live-only entries that Nuxt's predicate overload
  // would miss because it enumerates payload.data internally.
  clearNuxtData(keys)
  removeNuxtDataArtifacts(nuxt, keys)
  for (const key of keys) {
    cache.lastFetched.delete(key)
    const timer = cache.gcTimers.get(key)
    if (timer != null) {
      clearTimeout(timer)
      cache.gcTimers.delete(key)
    }
  }
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
