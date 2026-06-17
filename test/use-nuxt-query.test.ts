import { createQueryCache } from 'nuxt-use-query/cache'
import { NUXT_USE_QUERY_TELEMETRY_HOOKS } from 'nuxt-use-query/telemetry'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

// Unit tests for the `useNuxtQuery` composable. The module runtime uses
// explicit imports (no auto-imports), so we mock the Nuxt-side modules
// (`#app`, `@vueuse/core`) and the cache resolver to inject deterministic
// stand-ins. Real Vue runtime is used for reactivity.

let fetchState: { data: any, status: any, refresh: any }
let lastUseFetchOpts: any
let lastIntervalFn: any
let callHook: any
let runtimeConfig: any
const cache = createQueryCache()

vi.mock('#app', () => ({
  useFetch: (_url: any, opts: any) => {
    lastUseFetchOpts = opts
    return fetchState
  },
  useNuxtApp: () => ({ hooks: { callHook } }),
  useRuntimeConfig: () => runtimeConfig,
  clearNuxtData: vi.fn(),
}))

vi.mock('@vueuse/core', () => ({
  useDocumentVisibility: () => ref('visible'),
  useEventListener: vi.fn(),
  useIntervalFn: (fn: any) => {
    lastIntervalFn = { fn }
    return { pause: vi.fn(), resume: vi.fn() }
  },
}))

vi.mock('../src/runtime/composables/useQueryCache', async () => {
  const real = await vi.importActual<typeof import('../src/runtime/composables/useQueryCache')>(
    '../src/runtime/composables/useQueryCache',
  )
  return { ...real, useQueryCache: () => cache }
})

const { useNuxtQuery } = await import('nuxt-use-query/query')

beforeEach(async () => {
  const { nextTick } = await import('vue')
  cache.lastFetched.clear()
  cache.refCounts.clear()
  for (const t of cache.gcTimers.values()) clearTimeout(t)
  cache.gcTimers.clear()
  fetchState = { data: ref<any>(null), status: ref('idle'), refresh: vi.fn(() => Promise.resolve()) }
  callHook = vi.fn(() => Promise.resolve())
  runtimeConfig = { public: { nuxtUseQuery: { telemetry: { enabled: false } } } }
  void nextTick
})

async function tick() {
  const { nextTick } = await import('vue')
  await nextTick()
}

describe('useNuxtQuery keepPreviousData', () => {
  it('holds the previous result while a new key loads, flagging isPlaceholderData', async () => {
    const { displayData, isPlaceholderData } = useNuxtQuery<{ n: number }>('/api/x', { key: 'q' })

    expect(displayData.value).toBeNull()
    expect(isPlaceholderData.value).toBe(false)

    fetchState.data.value = { n: 1 }
    await tick()
    expect(displayData.value).toEqual({ n: 1 })

    fetchState.data.value = null
    await tick()
    expect(displayData.value).toEqual({ n: 1 })
    expect(isPlaceholderData.value).toBe(true)

    fetchState.data.value = { n: 2 }
    await tick()
    expect(displayData.value).toEqual({ n: 2 })
    expect(isPlaceholderData.value).toBe(false)
  })

  it('does not retain previous data when keepPreviousData is false', async () => {
    const { displayData } = useNuxtQuery<{ n: number }>('/api/x', { key: 'q', keepPreviousData: false })
    fetchState.data.value = { n: 1 }
    await tick()
    fetchState.data.value = null
    await tick()
    expect(displayData.value).toBeNull()
  })
})

describe('useNuxtQuery fetch stamping', () => {
  it('records a fetch only on a real pending → success transition', async () => {
    useNuxtQuery('/api/x', { key: 'q' })
    expect(cache.lastFetched.has('q')).toBe(false)
    fetchState.status.value = 'pending'
    await tick()
    fetchState.status.value = 'success'
    await tick()
    expect(cache.lastFetched.has('q')).toBe(true)
  })

  it('emits Nuxt app telemetry hooks for query start and finish', async () => {
    runtimeConfig.public.nuxtUseQuery.telemetry.enabled = true
    useNuxtQuery('/api/x', { key: 'q' })

    await lastUseFetchOpts.onRequest({})
    await lastUseFetchOpts.onResponse({})

    expect(callHook).toHaveBeenCalledWith(
      NUXT_USE_QUERY_TELEMETRY_HOOKS.queryStart,
      expect.objectContaining({
        key: 'q',
        request: '/api/x',
      }),
    )
    expect(callHook).toHaveBeenCalledWith(
      NUXT_USE_QUERY_TELEMETRY_HOOKS.queryFinish,
      expect.objectContaining({
        key: 'q',
        request: '/api/x',
        status: 'success',
      }),
    )
  })

  it('does not emit Nuxt app telemetry hooks when telemetry is disabled', async () => {
    useNuxtQuery('/api/x', { key: 'q' })

    await lastUseFetchOpts.onRequest({})
    await lastUseFetchOpts.onResponse({})

    expect(callHook).not.toHaveBeenCalled()
  })

  it('does not emit a success finish before an HTTP response error', async () => {
    runtimeConfig.public.nuxtUseQuery.telemetry.enabled = true
    useNuxtQuery('/api/x', { key: 'q' })

    const error = new Error('server failed')
    const context = { error, response: { ok: false, status: 500 } }
    await lastUseFetchOpts.onRequest(context)
    await lastUseFetchOpts.onResponse(context)
    await lastUseFetchOpts.onResponseError(context)

    const finishes = callHook.mock.calls.filter(([name]: [string]) => name === NUXT_USE_QUERY_TELEMETRY_HOOKS.queryFinish)
    expect(finishes).toHaveLength(1)
    expect(finishes[0][1]).toEqual(expect.objectContaining({
      error,
      status: 'error',
    }))
  })

  it('emits success for ignored HTTP response errors', async () => {
    runtimeConfig.public.nuxtUseQuery.telemetry.enabled = true
    useNuxtQuery('/api/x', { ignoreResponseError: true, key: 'q' })

    const context = { response: { ok: false, status: 404 } }
    await lastUseFetchOpts.onRequest(context)
    await lastUseFetchOpts.onResponse(context)

    expect(callHook).toHaveBeenCalledWith(
      NUXT_USE_QUERY_TELEMETRY_HOOKS.queryFinish,
      expect.objectContaining({
        key: 'q',
        status: 'success',
      }),
    )
  })

  it('reports a thrown response hook as a single error finish', async () => {
    runtimeConfig.public.nuxtUseQuery.telemetry.enabled = true
    const error = new Error('hook failed')
    useNuxtQuery('/api/x', {
      key: 'q',
      onResponse: () => {
        throw error
      },
    })

    const context = {}
    await lastUseFetchOpts.onRequest(context)
    await expect(lastUseFetchOpts.onResponse(context)).rejects.toThrow(error)
    await lastUseFetchOpts.onResponseError(context)

    const finishes = callHook.mock.calls.filter(([name]: [string]) => name === NUXT_USE_QUERY_TELEMETRY_HOOKS.queryFinish)
    expect(finishes).toHaveLength(1)
    expect(finishes[0][1]).toEqual(expect.objectContaining({
      error,
      status: 'error',
    }))
  })

  it('keeps the started query key and request for reactive inputs', async () => {
    runtimeConfig.public.nuxtUseQuery.telemetry.enabled = true
    const key = ref('first')
    const request = ref('/api/first')
    useNuxtQuery(request, { key })

    const context = {}
    await lastUseFetchOpts.onRequest(context)
    key.value = 'second'
    request.value = '/api/second'
    await lastUseFetchOpts.onResponse(context)

    expect(callHook).toHaveBeenCalledWith(
      NUXT_USE_QUERY_TELEMETRY_HOOKS.queryFinish,
      expect.objectContaining({
        key: 'first',
        request: '/api/first',
        status: 'success',
      }),
    )
  })
})

describe('useNuxtQuery enabled gate', () => {
  it('passes immediate: false to useFetch when initially disabled', () => {
    useNuxtQuery('/api/x', { key: 'q', enabled: false })
    expect(lastUseFetchOpts.immediate).toBe(false)
  })

  it('passes immediate: true (default) when enabled', () => {
    useNuxtQuery('/api/x', { key: 'q' })
    expect(lastUseFetchOpts.immediate).toBe(true)
  })

  it('refreshes once when enabled flips false → true', async () => {
    const enabled = ref(false)
    useNuxtQuery('/api/x', { key: 'q', enabled, staleTime: 60_000 })
    expect(fetchState.refresh).not.toHaveBeenCalled()

    enabled.value = true
    await tick()
    expect(fetchState.refresh).toHaveBeenCalledOnce()

    cache.lastFetched.set('q', Date.now())
    enabled.value = false
    await tick()
    enabled.value = true
    await tick()
    expect(fetchState.refresh).toHaveBeenCalledOnce()
  })
})

describe('useNuxtQuery TanStack-style refetch aliases', () => {
  it('exposes isPending and isFetching flags', () => {
    const query = useNuxtQuery('/api/x', { key: 'q' })
    fetchState.status.value = 'pending'

    expect(query.isPending.value).toBe(true)
    expect(query.isFetching.value).toBe(true)

    fetchState.data.value = { n: 1 }
    expect(query.isPending.value).toBe(false)
    expect(query.isFetching.value).toBe(true)
  })

  it('accepts static staleTime', () => {
    useNuxtQuery('/api/x', { key: 'q', staleTime: 'static' })
    expect(lastUseFetchOpts.key.value).toBe('q')
  })
})

describe('useNuxtQuery staleTime default', () => {
  // Regression: an earlier change bumped this to 30_000 to "dedupe sibling
  // mounts", but Nuxt's useAsyncData already dedupes concurrent fetches by
  // key. The documented default (README) is 0, matching TanStack v5.
  it('defaults staleTime to 0 so getCachedData treats any prior fetch as stale', () => {
    useNuxtQuery('/api/x', { key: 'q' })
    cache.lastFetched.set('q', Date.now())
    const cached = lastUseFetchOpts.getCachedData('q', {}, { cause: 'initial' })
    expect(cached).toBeUndefined()
  })

  it('returns cached data when staleTime is explicitly non-zero and within window', () => {
    const nuxtApp: any = { payload: { data: { q: { hit: true } } } }
    useNuxtQuery('/api/x', { key: 'q', staleTime: 60_000 })
    cache.lastFetched.set('q', Date.now())
    const cached = lastUseFetchOpts.getCachedData('q', nuxtApp, { cause: 'initial' })
    expect(cached).toEqual({ hit: true })
  })
})

describe('useNuxtQuery refetchInterval', () => {
  it('does not start polling when refetchInterval is undefined', () => {
    lastIntervalFn = undefined
    useNuxtQuery('/api/x', { key: 'q' })
    expect(lastIntervalFn).toBeUndefined()
  })

  it('invokes refresh when the interval fn fires and enabled is true', () => {
    useNuxtQuery('/api/x', { key: 'q', refetchInterval: 30_000 })
    expect(fetchState.refresh).not.toHaveBeenCalled()
    lastIntervalFn.fn()
    expect(fetchState.refresh).toHaveBeenCalledOnce()
  })

  it('does not fire the polled refresh when enabled is false', () => {
    useNuxtQuery('/api/x', { key: 'q', refetchInterval: 30_000, enabled: false })
    lastIntervalFn.fn()
    expect(fetchState.refresh).not.toHaveBeenCalled()
  })
})
