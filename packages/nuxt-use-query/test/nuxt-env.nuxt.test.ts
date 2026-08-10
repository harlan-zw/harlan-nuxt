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

import { retainQuery } from '@harlanzw/nuxt-use-query/cache'
import { useNuxtMutation } from '@harlanzw/nuxt-use-query/mutation'
import { useNuxtQuery } from '@harlanzw/nuxt-use-query/query'
import {
  getQueryData,
  invalidateNuxtQueries,
  NuxtQueryRefreshError,
  removeNuxtQueries,
  setQueryData,
  useQueryCache,
} from '@harlanzw/nuxt-use-query/query-cache'
import { defineNuxtRpcQuery, invalidateNuxtRpc, useNuxtRpcQuery } from '@harlanzw/nuxt-use-query/rpc'
import { registerEndpoint } from '@nuxt/test-utils/runtime'
import { describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { z } from 'zod'
import { clearNuxtData, useNuxtApp } from '#app'
import { seedCacheFromPayload } from '../src/runtime/query-cache-hydration'

// Counted handler so a refresh is observable by call count, not just shape.
const echoCalls = vi.fn()
registerEndpoint('/api/echo-env', {
  method: 'GET',
  handler: () => {
    echoCalls()
    return { call: echoCalls.mock.calls.length }
  },
})

const refreshFailureCalls = vi.fn()
let rejectRefresh = false
registerEndpoint('/api/refresh-failure-env', {
  method: 'GET',
  handler: () => {
    refreshFailureCalls()
    if (rejectRefresh)
      throw new Error('refresh failed over HTTP')
    return { ok: true }
  },
})

const invalidPostCalls = vi.fn()
registerEndpoint('/api/invalid-post-env', {
  method: 'POST',
  handler: () => {
    invalidPostCalls()
    return { ok: true }
  },
})

registerEndpoint('/api/invalid-response-env', {
  method: 'GET',
  handler: () => ({ count: 'not-a-number' }),
})

const pendingRemovalCalls = vi.fn()
let releasePendingRemoval: (() => void) | undefined
registerEndpoint('/api/pending-removal-env', {
  method: 'GET',
  handler: async () => {
    pendingRemovalCalls()
    await new Promise<void>((resolve) => {
      releasePendingRemoval = resolve
    })
    return { late: true }
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

    const refresh = invalidateNuxtQueries('inv-')
    // Freshness is cleared synchronously, before the returned refresh effect
    // settles and stamps it again.
    expect(cache.lastFetched.has('inv-a')).toBe(false)
    await refresh

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

  it('rejects when a real HTTP refetch parks an error in active async data', async () => {
    rejectRefresh = false
    refreshFailureCalls.mockClear()
    const query = await useNuxtQuery<{ ok: boolean }>('/api/refresh-failure-env', {
      key: 'refresh-failure',
    })
    expect(query.data.value).toEqual({ ok: true })

    rejectRefresh = true
    try {
      const refresh = invalidateNuxtQueries('refresh-failure')
      await expect(refresh).rejects.toBeInstanceOf(NuxtQueryRefreshError)
      await expect(refresh).rejects.toMatchObject({
        failures: [expect.objectContaining({ key: 'refresh-failure' })],
      })
      expect(query.status.value).toBe('error')
      expect(query.error.value).toBeTruthy()
      // ofetch may retry the failing 500, so assert a genuine second request
      // rather than coupling the API contract to transport retry defaults.
      expect(refreshFailureCalls.mock.calls.length).toBeGreaterThanOrEqual(2)
    }
    finally {
      rejectRefresh = false
    }
  })

  it('parks an invalid declarative POST body without issuing an HTTP request', async () => {
    invalidPostCalls.mockClear()
    const scope = effectScope()
    try {
      const pending = scope.run(() => useNuxtRpcQuery(defineNuxtRpcQuery({
        key: 'invalid-post-env',
        method: 'POST',
        idempotent: true,
        path: '/api/invalid-post-env',
        body: {
          schema: z.object({ term: z.string() }),
          value: { term: 123 } as any,
        },
        response: z.object({ ok: z.boolean() }),
      })))!
      const query = await pending

      expect(invalidPostCalls).not.toHaveBeenCalled()
      expect(query.status.value).toBe('error')
      expect(query.error.value).toMatchObject({
        type: 'request-validation',
        issues: [expect.objectContaining({ path: 'term' })],
      })
    }
    finally {
      scope.stop()
    }
  })

  it('preserves response-validation tags across Nuxt AsyncData error wrapping', async () => {
    const scope = effectScope()
    try {
      const pending = scope.run(() => useNuxtRpcQuery(defineNuxtRpcQuery({
        key: 'invalid-response-env',
        path: '/api/invalid-response-env',
        response: z.object({ count: z.number() }),
      })))!
      const query = await pending

      expect(query.status.value).toBe('error')
      expect(query.error.value).toMatchObject({
        type: 'response-validation',
        issues: [expect.objectContaining({ path: 'count' })],
      })
    }
    finally {
      scope.stop()
    }
  })

  it('does not report an unmounted query\'s parked error as an active refresh failure', async () => {
    rejectRefresh = false
    refreshFailureCalls.mockClear()
    const scope = effectScope()
    try {
      const pending = scope.run(() => useNuxtQuery<{ ok: boolean }>('/api/refresh-failure-env', {
        key: 'inactive-refresh-failure',
      }))!
      const query = await pending

      rejectRefresh = true
      await expect(invalidateNuxtQueries('inactive-refresh-failure')).rejects.toBeInstanceOf(NuxtQueryRefreshError)
      expect(query.status.value).toBe('error')
      scope.stop()
      const callsAfterUnmount = refreshFailureCalls.mock.calls.length

      // Nuxt retains `_asyncData[key]` with its old error but removes the refresh
      // hook when `_deps` reaches zero. It is inactive: invalidation should only
      // clear freshness, not re-read that stale error as a new failed refresh.
      await expect(invalidateNuxtQueries('inactive-refresh-failure')).resolves.toBeUndefined()
      expect(refreshFailureCalls.mock.calls.length).toBe(callsAfterUnmount)
    }
    finally {
      scope.stop()
      rejectRefresh = false
    }
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

    // The read was refetched by the mutation's invalidates entry, with no
    // hand-wired refresh wiring at the callsite — proves the mutation →
    // `invalidateNuxtQueries` → Nuxt's `_asyncData` + `refreshNuxtData` chain.
    expect(read.data.value?.call).toBeGreaterThan(readBefore!)
  })

  it('removeNuxtQueries clears every data/freshness store without refetching', async () => {
    const cache = useQueryCache()
    echoCalls.mockClear()
    const query = await useNuxtQuery<{ call: number }>('/api/echo-env', { key: 'remove-live' })
    expect(query.data.value).toBeDefined()

    const nuxt = useNuxtApp() as unknown as {
      payload: { data: Record<string, unknown>, nuxtQueryMeta?: Record<string, number> }
      static: { data: Record<string, unknown> }
    }
    nuxt.static ??= { data: {} }
    nuxt.static.data ??= {}
    nuxt.static.data['remove-live'] = { stale: true }
    nuxt.payload.nuxtQueryMeta ??= {}
    nuxt.payload.nuxtQueryMeta['remove-live'] = 123
    cache.lastFetched.set('remove-live', 123)
    cache.gcTimers.set('remove-live', setTimeout(() => {}, 60_000))
    const callsBeforeRemove = echoCalls.mock.calls.length

    removeNuxtQueries('remove-')

    expect(query.data.value).toBeUndefined()
    expect(query.status.value).toBe('idle')
    expect(getQueryData('remove-live')).toBeUndefined()
    expect(nuxt.payload.data).not.toHaveProperty('remove-live')
    expect(nuxt.static.data).not.toHaveProperty('remove-live')
    expect(nuxt.payload.nuxtQueryMeta).not.toHaveProperty('remove-live')
    expect(cache.lastFetched.has('remove-live')).toBe(false)
    expect(cache.gcTimers.has('remove-live')).toBe(false)
    await new Promise(r => setTimeout(r, 10))
    expect(echoCalls.mock.calls.length).toBe(callsBeforeRemove)
  })

  it('prevents an already-pending request from resurrecting removed data', async () => {
    pendingRemovalCalls.mockClear()
    releasePendingRemoval = undefined
    const scope = effectScope()
    try {
      const query = scope.run(() => useNuxtQuery<{ late: boolean }>('/api/pending-removal-env', {
        key: 'remove-pending',
      }))!
      await vi.waitFor(() => expect(pendingRemovalCalls).toHaveBeenCalledOnce())

      const nuxt = useNuxtApp() as unknown as {
        _asyncDataPromises: Record<string, Promise<unknown> | undefined>
        payload: { data: Record<string, unknown>, _errors: Record<string, unknown> }
      }
      removeNuxtQueries('remove-pending')
      expect(query.data.value).toBeUndefined()
      expect(query.status.value).toBe('idle')
      expect(nuxt._asyncDataPromises['remove-pending']).toBeUndefined()
      expect(nuxt.payload.data).not.toHaveProperty('remove-pending')
      expect(nuxt.payload._errors['remove-pending']).toBeUndefined()

      releasePendingRemoval!()
      await query
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(query.data.value).toBeUndefined()
      expect(query.status.value).toBe('idle')
      expect(nuxt.payload.data).not.toHaveProperty('remove-pending')
      expect(pendingRemovalCalls).toHaveBeenCalledOnce()
    }
    finally {
      releasePendingRemoval?.()
      scope.stop()
    }
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

  it('invalidateNuxtRpc invalidates by the operation key serialized form', async () => {
    const cache = useQueryCache()
    cache.lastFetched.clear()
    echoCalls.mockClear()

    // ['pro','echo',siteId] serializes to `pro:echo:<siteId>` — the same key
    // `useNuxtRpcQuery` would register, so a raw `useNuxtQuery` under it matches.
    await useNuxtQuery<{ call: number }>('/api/echo-env', { key: 'pro:echo:s1' })
    const before = echoCalls.mock.calls.length

    await invalidateNuxtRpc({ key: ['pro', 'echo', 's1'] })

    expect(echoCalls.mock.calls.length).toBe(before + 1)
  })

  it('invalidateNuxtQueries with a predicate filter matches arbitrary keys', async () => {
    const cache = useQueryCache()
    cache.lastFetched.clear()
    echoCalls.mockClear()

    await useNuxtQuery<{ call: number }>('/api/echo-env', { key: 'pred-keep-1' })
    await useNuxtQuery<{ call: number }>('/api/echo-env', { key: 'pred-keep-2' })
    await useNuxtQuery<{ call: number }>('/api/echo-env', { key: 'pred-drop' })
    const baseline = echoCalls.mock.calls.length

    await invalidateNuxtQueries(k => k.endsWith('-1') || k.endsWith('-2'))

    // Only the two `-1`/`-2` keys refetched; `-drop` was untouched.
    expect(echoCalls.mock.calls.length).toBe(baseline + 2)
  })

  it('two useNuxtQuery calls with the same key dedupe to a single network request', async () => {
    const cache = useQueryCache()
    cache.lastFetched.clear()
    echoCalls.mockClear()

    // Simulates a parent + nested child both mounting the same key in the
    // same tick. With Nuxt's _asyncDataPromises dedup, only one fetch hits.
    const [a, b] = await Promise.all([
      useNuxtQuery<{ call: number }>('/api/echo-env', { key: 'dup-key' }),
      useNuxtQuery<{ call: number }>('/api/echo-env', { key: 'dup-key' }),
    ])

    expect(echoCalls.mock.calls.length).toBe(1)
    expect(a.data.value?.call).toBe(b.data.value?.call)
  })

  it('a second useNuxtQuery mount AFTER the first resolved does not refetch with staleTime > 0', async () => {
    const cache = useQueryCache()
    cache.lastFetched.clear()
    echoCalls.mockClear()

    await useNuxtQuery<{ call: number }>('/api/echo-env', { key: 'dup-key-2', staleTime: 60_000 })
    const callsAfterFirst = echoCalls.mock.calls.length

    // Second mount, sequential — fresh cache should be reused.
    await useNuxtQuery<{ call: number }>('/api/echo-env', { key: 'dup-key-2', staleTime: 60_000 })
    expect(echoCalls.mock.calls.length).toBe(callsAfterFirst)
  })

  it('sequential stale remount with the same key refetches by default', async () => {
    // Nuxt reuses an existing `_asyncData[X]` entry on sequential mounts, so
    // `useNuxtQuery` explicitly refreshes stale resolved data to preserve the
    // documented refetchOnMount default.
    const cache = useQueryCache()
    cache.lastFetched.clear()
    echoCalls.mockClear()

    await useNuxtQuery<{ call: number }>('/api/echo-env', { key: 'dup-key-3' })
    const callsAfterFirst = echoCalls.mock.calls.length

    await useNuxtQuery<{ call: number }>('/api/echo-env', { key: 'dup-key-3' })
    await new Promise(r => setTimeout(r, 50))
    expect(echoCalls.mock.calls.length).toBeGreaterThan(callsAfterFirst)
  })

  it('a hydration-seeded payload key is served by getCachedData (no refetch) with staleTime > 0', async () => {
    // Simulate SSR → client hydration: the payload carries the server's data
    // but the per-app `lastFetched` map is empty (it isn't serialized). Seeding
    // it (what `useQueryCache` does on client cache creation) must make the
    // first mount read the payload instead of hitting the endpoint again.
    const cache = useQueryCache()
    cache.lastFetched.clear()
    echoCalls.mockClear()

    const nuxt = useNuxtApp() as unknown as { payload: { data: Record<string, unknown> } }
    nuxt.payload.data['hydrated-key'] = { call: 0, fromPayload: true }
    seedCacheFromPayload(cache, nuxt)

    const q = await useNuxtQuery<{ call: number, fromPayload?: boolean }>('/api/echo-env', {
      key: 'hydrated-key',
      staleTime: 60_000,
    })

    // Served from the seeded payload — the endpoint was never hit.
    expect(echoCalls.mock.calls.length).toBe(0)
    expect(q.data.value?.fromPayload).toBe(true)
  })

  it('invalidateNuxtQueries with no prefix refreshes every active key', async () => {
    const cache = useQueryCache()
    cache.lastFetched.clear()
    echoCalls.mockClear()

    await useNuxtQuery<{ call: number }>('/api/echo-env', { key: 'all-a' })
    await useNuxtQuery<{ call: number }>('/api/echo-env', { key: 'all-b' })
    const countAfterInitial = echoCalls.mock.calls.length

    await invalidateNuxtQueries()

    // Both keys refetched, so the endpoint was hit twice more.
    expect(echoCalls.mock.calls.length).toBeGreaterThanOrEqual(countAfterInitial + 2)
  })

  it('invalidateNuxtQueries marks inactive payload-only keys stale for the next mount', async () => {
    const cache = useQueryCache()
    cache.lastFetched.clear()
    echoCalls.mockClear()

    setQueryData<{ call: number, fromPayload: boolean }>('inactive-sites:1', {
      call: 0,
      fromPayload: true,
    })
    expect(cache.lastFetched.has('inactive-sites:1')).toBe(true)

    await invalidateNuxtQueries('inactive-sites:')
    expect(cache.lastFetched.has('inactive-sites:1')).toBe(false)

    const q = await useNuxtQuery<{ call: number, fromPayload?: boolean }>('/api/echo-env', {
      key: 'inactive-sites:1',
      staleTime: 60_000,
    })

    expect(echoCalls.mock.calls.length).toBe(1)
    expect(q.data.value?.fromPayload).toBeUndefined()
    expect(q.data.value?.call).toBeGreaterThan(0)
  })
})
