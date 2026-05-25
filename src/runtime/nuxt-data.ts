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
  payload: { data: Record<string, unknown> }
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
