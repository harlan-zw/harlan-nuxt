import {
  createQueryCache,
  isQueryStale,
  markQueryFetched,
  retainQuery,
} from 'nuxt-use-query/cache'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pure cache helpers. No Nuxt runtime, no stubs — these are plain functions
// that take a `QueryCache` instance. The composables (useNuxtQuery,
// useNuxtMutation) are integration-tested separately under a Nuxt environment.

let cache = createQueryCache()
beforeEach(() => {
  cache = createQueryCache()
})

describe('staleness helpers', () => {
  it('treats a key with no recorded fetch as stale', () => {
    expect(isQueryStale(cache, 'k', 60_000)).toBe(true)
  })

  it('is fresh within the stale window, stale beyond it', () => {
    markQueryFetched(cache, 'k', 1_000)
    expect(isQueryStale(cache, 'k', 60_000, 1_000 + 30_000)).toBe(false)
    expect(isQueryStale(cache, 'k', 60_000, 1_000 + 90_000)).toBe(true)
  })

  it('is immediately stale when staleTime is 0', () => {
    markQueryFetched(cache, 'k', 1_000)
    expect(isQueryStale(cache, 'k', 0, 1_000)).toBe(true)
  })

  it('never goes stale when staleTime is Infinity (immutable-data sentinel)', () => {
    markQueryFetched(cache, 'k', 1_000)
    expect(isQueryStale(cache, 'k', Number.POSITIVE_INFINITY, 1_000 + 10 ** 9)).toBe(false)
  })

  it('still treats immutable keys as stale until they have been fetched once', () => {
    expect(isQueryStale(cache, 'k', Number.POSITIVE_INFINITY)).toBe(true)
    expect(isQueryStale(cache, 'k', 'static')).toBe(true)
  })

  it('never goes stale when staleTime is static', () => {
    markQueryFetched(cache, 'k', 1_000)
    expect(isQueryStale(cache, 'k', 'static', 1_000 + 10 ** 9)).toBe(false)
  })
})

describe('retainQuery (gcTime eviction)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('evicts after gcTime when the last consumer releases', () => {
    const evict = vi.fn()
    const release = retainQuery(cache, 'k', 1_000, evict)
    markQueryFetched(cache, 'k', 1)

    release()
    expect(evict).not.toHaveBeenCalled()
    vi.advanceTimersByTime(999)
    expect(evict).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(evict).toHaveBeenCalledOnce()
    // lastFetched is dropped as part of the sweep
    expect(isQueryStale(cache, 'k', 1, 10 ** 9)).toBe(true)
  })

  it('does not evict while a second consumer is still mounted', () => {
    const evict = vi.fn()
    const r1 = retainQuery(cache, 'k', 1_000, evict)
    const r2 = retainQuery(cache, 'k', 1_000, evict)
    r1()
    vi.advanceTimersByTime(5_000)
    expect(evict).not.toHaveBeenCalled()
    r2()
    vi.advanceTimersByTime(1_000)
    expect(evict).toHaveBeenCalledOnce()
  })

  it('a remount within the gcTime window cancels eviction', () => {
    const evict = vi.fn()
    const release = retainQuery(cache, 'k', 1_000, evict)
    release()
    vi.advanceTimersByTime(500)
    const release2 = retainQuery(cache, 'k', 1_000, evict)
    vi.advanceTimersByTime(10_000)
    expect(evict).not.toHaveBeenCalled()
    release2()
    vi.advanceTimersByTime(1_000)
    expect(evict).toHaveBeenCalledOnce()
  })

  it('release functions are idempotent', () => {
    const evict = vi.fn()
    const release = retainQuery(cache, 'k', 1_000, evict)
    release()
    release()

    const release2 = retainQuery(cache, 'k', 1_000, evict)
    vi.advanceTimersByTime(10_000)
    expect(evict).not.toHaveBeenCalled()

    release2()
    vi.advanceTimersByTime(1_000)
    expect(evict).toHaveBeenCalledOnce()
  })

  it('gcTime: 0 disables eviction', () => {
    const evict = vi.fn()
    const release = retainQuery(cache, 'k', 0, evict)
    release()
    vi.advanceTimersByTime(10 ** 9)
    expect(evict).not.toHaveBeenCalled()
  })

  it('gcTime: Infinity disables eviction', () => {
    const evict = vi.fn()
    const release = retainQuery(cache, 'k', Number.POSITIVE_INFINITY, evict)

    release()
    vi.runAllTimers()

    expect(evict).not.toHaveBeenCalled()
    expect(cache.gcTimers.has('k')).toBe(false)
  })

  it('does not overflow long finite gcTime values into immediate eviction', () => {
    const evict = vi.fn()
    const maxTimerDelay = 2 ** 31 - 1
    const release = retainQuery(cache, 'k', maxTimerDelay + 1_000, evict)

    release()
    vi.advanceTimersByTime(maxTimerDelay)
    expect(evict).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1_000)
    expect(evict).toHaveBeenCalledOnce()
  })
})
