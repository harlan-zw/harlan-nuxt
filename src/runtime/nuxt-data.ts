// Concentrates every reach into Nuxt's private data registries
// (`_asyncData`, `payload.data`, `static.data`) so the unsafe-cast surface
// lives in one file. `useNuxtData()` covers reads but writes only one store;
// our optimistic writes need both `_asyncData[key].data.value` (live consumers)
// and `payload.data[key]` (next mount's `getCachedData` fallback).

interface AsyncDataEntry {
  /** Nuxt's live consumer count. Missing on older supported Nuxt internals. */
  _deps?: number
  data: { value: unknown }
  error?: { value: unknown }
  status?: { value: string }
}

interface NuxtDataInternals {
  _asyncData?: Record<string, AsyncDataEntry | undefined>
  payload: { data: Record<string, unknown>, nuxtQueryMeta?: Record<string, number> }
  static?: { data?: Record<string, unknown> }
}

function internals(nuxt: unknown): NuxtDataInternals {
  return nuxt as NuxtDataInternals
}

/**
 * Read `key` from the same chain Nuxt's own `useNuxtData(key)` uses, plus
 * `static.data` as a final fallback for prerendered hydration.
 */
export function readNuxtData<T = unknown>(nuxt: unknown, key: string): T | undefined {
  const n = internals(nuxt)
  const live = n._asyncData?.[key]?.data.value as T | undefined
  if (live !== undefined)
    return live
  const payload = n.payload.data?.[key] as T | undefined
  if (payload !== undefined)
    return payload
  return n.static?.data?.[key] as T | undefined
}

/**
 * Write `value` to BOTH stores Nuxt reads from. The dual-write is
 * deliberate: a `setQueryData` that lands before any consumer mounts must
 * still be visible to the next `getCachedData` fallback via `payload.data`.
 */
export function writeNuxtData<T>(nuxt: unknown, key: string, value: T): void {
  const n = internals(nuxt)
  n.payload.data ??= {}
  n.payload.data[key] = value
  const live = n._asyncData?.[key]
  if (live)
    live.data.value = value
}

/** Active query keys registered with Nuxt — drives prefix invalidation. */
export function listActiveNuxtDataKeys(nuxt: unknown, matches?: (key: string) => boolean): string[] {
  const entries = internals(nuxt)._asyncData ?? {}
  const keys: string[] = []
  for (const key of Object.keys(entries)) {
    const entry = entries[key]
    // Nuxt retains an entry after its final consumer unmounts, but removes its
    // refresh hook and sets `_deps` to zero. Treating that retained entry as
    // active can make invalidation inspect an old parked error even though no
    // refresh ran. Older Nuxt versions without `_deps` stay conservative.
    if (entry != null && (entry._deps == null || entry._deps > 0) && (!matches || matches(key)))
      keys.push(key)
  }
  return keys
}

export interface NuxtDataRefreshFailure {
  error: unknown
  key: string
}

/** Failures parked by Nuxt after an awaited `refreshNuxtData` hook settles. */
export function readNuxtDataRefreshFailures(nuxt: unknown, keys: readonly string[]): NuxtDataRefreshFailure[] {
  const entries = internals(nuxt)._asyncData ?? {}
  const failures: NuxtDataRefreshFailure[] = []
  for (const key of keys) {
    const entry = entries[key]
    if (!entry || (entry.status?.value !== 'error' && entry.error?.value == null))
      continue
    failures.push({
      error: entry.error?.value ?? new Error(`Query refresh failed for ${key}.`),
      key,
    })
  }
  return failures
}

/**
 * Keys carried in the serialized hydration stores (`payload.data` for SSR,
 * `static.data` for prerendered / payload-extracted pages). On the client these
 * are populated synchronously at hydration, BEFORE any query mounts, so they let
 * us seed the (non-serialized) `lastFetched` cache from data the server already
 * fetched — turning the redundant post-hydration refetch into a payload read.
 * `_asyncData` is intentionally NOT included: it isn't populated until each
 * query mounts, which is too late. The union mirrors `readNuxtData`'s own
 * `payload.data` → `static.data` fallback so every key it can serve is seeded.
 */
export function listPayloadDataKeys(nuxt: unknown): string[] {
  const n = internals(nuxt)
  const keys = new Set(Object.keys(n.payload.data ?? {}))
  for (const k of Object.keys(n.static?.data ?? {}))
    keys.add(k)
  return [...keys]
}

/** Every query key known to Nuxt, including live and prerender-only entries. */
export function listNuxtDataKeys(nuxt: unknown): string[] {
  const n = internals(nuxt)
  const keys = new Set(Object.keys(n._asyncData ?? {}))
  for (const key of listPayloadDataKeys(nuxt))
    keys.add(key)
  return [...keys]
}

/**
 * Per-key `lastFetched` timestamps the server stashed in the payload so the
 * client can seed with the ACTUAL fetch time instead of the hydration moment
 * (matters when `staleTime` is shorter than the SSR→hydration gap). Absent when
 * the serialize plugin didn't run (e.g. a client-only first paint).
 */
export function readQueryMeta(nuxt: unknown): Record<string, number> | undefined {
  return internals(nuxt).payload.nuxtQueryMeta
}

/** Write the serialized `lastFetched` map into the payload (server, at render). */
export function writeQueryMeta(nuxt: unknown, meta: Record<string, number>): void {
  internals(nuxt).payload.nuxtQueryMeta = meta
}

/**
 * Remove stores that Nuxt's public `clearNuxtData` does not cover. In
 * particular, a cleared payload key must not fall through to stale
 * `static.data` on a payload-extracted/prerendered page.
 */
export function removeNuxtDataArtifacts(nuxt: unknown, keys: readonly string[]): void {
  const n = internals(nuxt)
  for (const key of keys) {
    const live = n._asyncData?.[key]
    if (live) {
      live.data.value = undefined
      if (live.error)
        live.error.value = undefined
      if (live.status)
        live.status.value = 'idle'
    }
    if (key in n.payload.data)
      delete n.payload.data[key]
    if (n.static?.data && key in n.static.data)
      delete n.static.data[key]
    if (n.payload.nuxtQueryMeta && key in n.payload.nuxtQueryMeta)
      delete n.payload.nuxtQueryMeta[key]
  }
}
