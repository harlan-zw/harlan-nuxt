// In-process Nuxt env tests. Scoped to the dedicated `nuxt-use-query` vitest
// project so the Nuxt vite resolver stays isolated and doesn't bleed into the
// 60+ tests in the `default` project.
//
// What this file covers that the unit tests + e2e setup can't:
//
//   1. The composables actually run against a real `useNuxtApp()` — proves
//      the cache attachment via `useQueryCache()` works against live state.
//   2. `invalidateNuxtQueries(prefix)` reads `nuxtApp._asyncData` from a real
//      `useNuxtQuery` call and triggers `refreshNuxtData` — the central
//      Nuxt-primitive bet, end-to-end.
//   3. `useNuxtQuery` fetches a `registerEndpoint`-mocked Nitro handler and
//      stamps `lastFetched` after pending → success.

import { registerEndpoint } from '@nuxt/test-utils/runtime'
import { retainQuery } from 'nuxt-use-query/cache'
import { useNuxtMutation } from 'nuxt-use-query/mutation'
import { useNuxtQuery } from 'nuxt-use-query/query'
import {
  getQueryData,
  invalidateNuxtQueries,
  setQueryData,
  useQueryCache,
} from 'nuxt-use-query/query-cache'
import { describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { clearNuxtData, useNuxtApp } from '#app'

// Counted handler so a refresh is observable by call count, not just shape.
const echoCalls = vi.fn()
registerEndpoint('/api/echo-env', {
  method: 'GET',
  handler: () => {
    echoCalls()
    return { call: echoCalls.mock.calls.length }
  },
})

describe('nuxt-use-query · nuxt-env (in-process Nuxt)', () => {
  it('useQueryCache returns a per-Nuxt-app instance', () => {
    const a = useQueryCache()
    const b = useQueryCache()
    expect(a).toBe(b)
    expect(a.lastFetched).toBeInstanceOf(Map)
    expect(a.refCounts).toBeInstanceOf(Map)
    expect(a.gcTimers).toBeInstanceOf(Map)
  })

  it('useNuxtQuery fetches the endpoint and stamps the cache', async () => {
    const cache = useQueryCache()
    cache.lastFetched.delete('env-echo')

    const q = await useNuxtQuery<{ call: number }>('/api/echo-env', { key: 'env-echo' })

    expect(q.data.value?.call).toBeGreaterThan(0)
    // A real pending → success transition recorded `lastFetched`.
    expect(cache.lastFetched.has('env-echo')).toBe(true)
  })

  it('invalidateNuxtQueries(prefix) refetches matching keys via nuxtApp._asyncData', async () => {
    const cache = useQueryCache()
    cache.lastFetched.clear()
    echoCalls.mockClear()

    const a = await useNuxtQuery<{ call: number }>('/api/echo-env', { key: 'inv-a' })
    const b = await useNuxtQuery<{ call: number }>('/api/echo-env', { key: 'other-b' })

    const aCallBefore = a.data.value?.call
    const bCallBefore = b.data.value?.call
    const echoCountBefore = echoCalls.mock.calls.length

    invalidateNuxtQueries('inv-')
    // `refreshNuxtData` resolves asynchronously; wait one microtask + a tick.
    await new Promise(r => setTimeout(r, 50))

    // The matching key was refetched (call counter advanced).
    expect(a.data.value?.call).toBeGreaterThan(aCallBefore!)
    // The unrelated key was untouched.
    expect(b.data.value?.call).toBe(bCallBefore)
    // Endpoint was hit exactly once more.
    expect(echoCalls.mock.calls.length).toBe(echoCountBefore + 1)
    // `lastFetched` was dropped at invalidation time and re-stamped by the
    // re-fetch's pending → success transition.
    expect(cache.lastFetched.has('inv-a')).toBe(true)
  })

  it('useNuxtMutation declaring an invalidates prefix refetches matching reads end-to-end', async () => {
    const cache = useQueryCache()
    cache.lastFetched.clear()
    echoCalls.mockClear()

    const read = await useNuxtQuery<{ call: number }>('/api/echo-env', { key: 'mut-read' })
    const readBefore = read.data.value?.call
    expect(readBefore).toBeGreaterThan(0)

    const mutation = useNuxtMutation({
      mutation: async () => 'ok',
      invalidates: ['mut-'],
    })
    await mutation.mutate()
    await new Promise(r => setTimeout(r, 50))

    // The read was refetched by the mutation's invalidates entry, with no
    // hand-wired refresh wiring at the callsite — proves the mutation →
    // `invalidateNuxtQueries` → Nuxt's `_asyncData` + `refreshNuxtData` chain.
    expect(read.data.value?.call).toBeGreaterThan(readBefore!)
  })

  it('retainQuery release schedules a real clearNuxtData(key) eviction', async () => {
    const cache = useQueryCache()
    const nuxt = useNuxtApp() as unknown as { payload: { data: Record<string, unknown> } }
    nuxt.payload.data ??= {}
    nuxt.payload.data['gc-key'] = { stamped: true }
    cache.lastFetched.set('gc-key', Date.now())

    // Mount-equivalent: retain with a tiny gcTime; release synchronously.
    const release = retainQuery(cache, 'gc-key', 10, () => clearNuxtData('gc-key'))
    release()

    expect(nuxt.payload.data['gc-key']).toBeDefined()
    await new Promise(r => setTimeout(r, 30))

    // gcTime elapsed → `clearNuxtData` ran → Nuxt's payload entry is gone and
    // our `lastFetched` stamp was dropped as part of the sweep.
    expect(nuxt.payload.data['gc-key']).toBeUndefined()
    expect(cache.lastFetched.has('gc-key')).toBe(false)
  })

  it('a useNuxtQuery scope dispose releases the mount refcount', () => {
    const cache = useQueryCache()
    const scope = effectScope()
    scope.run(() => {
      void useNuxtQuery('/api/echo-env', { key: 'scoped-key', gcTime: 0 })
    })
    // Refcount stamped on mount.
    expect(cache.refCounts.get('scoped-key')).toBe(1)

    scope.stop()
    // onScopeDispose fired → refcount back to zero (gcTime: 0 disables the
    // eviction timer, so the count is simply released).
    expect(cache.refCounts.has('scoped-key')).toBe(false)
  })

  it('setQueryData writes to nuxtApp.payload.data, getQueryData reads it back', () => {
    const previous = setQueryData<{ items: number[] }>('opt-1', { items: [1, 2, 3] })
    expect(previous).toBeUndefined()
    expect(getQueryData<{ items: number[] }>('opt-1')).toEqual({ items: [1, 2, 3] })

    // Updater form sees the previous value and can append.
    const justOverwrote = setQueryData<{ items: number[] }>('opt-1', prev => ({
      items: [...(prev?.items ?? []), 4],
    }))
    expect(justOverwrote).toEqual({ items: [1, 2, 3] })
    expect(getQueryData<{ items: number[] }>('opt-1')).toEqual({ items: [1, 2, 3, 4] })

    const nuxt = useNuxtApp() as unknown as { payload: { data: Record<string, unknown> } }
    expect(nuxt.payload.data['opt-1']).toEqual({ items: [1, 2, 3, 4] })
  })

  it('setQueryData updates the live useNuxtQuery data ref, not just payload.data', async () => {
    // Mount a query first so `_asyncData[key]` exists with a live ref.
    const q = await useNuxtQuery<{ call: number }>('/api/echo-env', {
      key: 'live-write',
    })
    expect(q.data.value?.call).toBeGreaterThan(0)

    // Optimistically rewrite the cached value.
    setQueryData<{ call: number }>('live-write', { call: 99_999 })

    // The active query's data ref reflects the write — without the
    // `_asyncData[key].data.value = next` step in setQueryData, this would
    // still show the original server value because the ref consumers see
    // is bound to `_asyncData[key].data`, not `payload.data`.
    expect(q.data.value?.call).toBe(99_999)
    expect(getQueryData<{ call: number }>('live-write')?.call).toBe(99_999)
  })

  it('optimistic mutation rolls back via onError using the onMutate snapshot', async () => {
    setQueryData<{ count: number }>('opt-count', { count: 10 })

    const m = useNuxtMutation<void, void, { previous: { count: number } | undefined }>({
      onMutate: () => {
        // Snapshot, then optimistically bump the cached count.
        const previous = getQueryData<{ count: number }>('opt-count')
        setQueryData<{ count: number }>('opt-count', { count: (previous?.count ?? 0) + 1 })
        return { previous }
      },
      mutation: async () => { throw new Error('server rejected') },
      onError: (_err, _args, ctx) => {
        if (ctx?.previous)
          setQueryData('opt-count', ctx.previous)
      },
    })

    await m.mutate()

    // The optimistic write (count: 11) was rolled back to the snapshot (10),
    // proving the onMutate → onError context flow against real Nuxt payload.
    expect(getQueryData<{ count: number }>('opt-count')).toEqual({ count: 10 })
  })

  it('invalidateNuxtQueries with a predicate filter matches arbitrary keys', async () => {
    const cache = useQueryCache()
    cache.lastFetched.clear()
    echoCalls.mockClear()

    await useNuxtQuery<{ call: number }>('/api/echo-env', { key: 'pred-keep-1' })
    await useNuxtQuery<{ call: number }>('/api/echo-env', { key: 'pred-keep-2' })
    await useNuxtQuery<{ call: number }>('/api/echo-env', { key: 'pred-drop' })
    const baseline = echoCalls.mock.calls.length

    invalidateNuxtQueries(k => k.endsWith('-1') || k.endsWith('-2'))
    await new Promise(r => setTimeout(r, 50))

    // Only the two `-1`/`-2` keys refetched; `-drop` was untouched.
    expect(echoCalls.mock.calls.length).toBe(baseline + 2)
  })

  it('invalidateNuxtQueries with no prefix refreshes every active key', async () => {
    const cache = useQueryCache()
    cache.lastFetched.clear()
    echoCalls.mockClear()

    await useNuxtQuery<{ call: number }>('/api/echo-env', { key: 'all-a' })
    await useNuxtQuery<{ call: number }>('/api/echo-env', { key: 'all-b' })
    const countAfterInitial = echoCalls.mock.calls.length

    invalidateNuxtQueries()
    await new Promise(r => setTimeout(r, 50))

    // Both keys refetched, so the endpoint was hit twice more.
    expect(echoCalls.mock.calls.length).toBeGreaterThanOrEqual(countAfterInitial + 2)
  })
})
