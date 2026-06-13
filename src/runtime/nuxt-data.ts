// Concentrates every reach into Nuxt's private data registries
// (`_asyncData`, `payload.data`, `static.data`) so the unsafe-cast surface
// lives in one file. `useNuxtData()` covers reads but writes only one store;
// our optimistic writes need both `_asyncData[key].data.value` (live consumers)
// and `payload.data[key]` (next mount's `getCachedData` fallback).

interface AsyncDataEntry {
  data: { value: unknown }
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
  return (n.payload.data?.[key] ?? n.static?.data?.[key]) as T | undefined
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
export function listActiveNuxtDataKeys(nuxt: unknown): string[] {
  return Object.keys(internals(nuxt)._asyncData ?? {})
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
