import type { ComputedRef, Ref } from 'vue'
import type { QueryStaleTime } from './cache'
import type { useQueryCache } from './composables/useQueryCache'
import { useDocumentVisibility, useEventListener, useIntervalFn } from '@vueuse/core'
import { computed, getCurrentScope, onScopeDispose, shallowRef, toValue, watch } from 'vue'
import { clearNuxtData } from '#app'
import { isQueryStale, markQueryFetched, retainQuery } from './cache'

// The post-fetch lifecycle shared by every query primitive, regardless of how
// the underlying request is made (`useFetch` URL or `useAsyncData` handler).
// It only touches the `AsyncData` surface (`data` / `status` / `refresh`), so
// both `useNuxtQuery` and `useNuxtAsyncQuery` wire identical SWR, GC, and
// refetch-trigger behaviour by handing their query object to this function.

/** The minimal `AsyncData` surface this lifecycle reads/extends. */
export interface LifecycleQuery {
  data: Ref<any>
  status: Ref<string>
  refresh: () => Promise<void>
  displayData?: ComputedRef<any>
  isPlaceholderData?: ComputedRef<boolean>
  isPending?: ComputedRef<boolean>
  isFetching?: ComputedRef<boolean>
}

export interface QueryLifecycleOptions {
  cache: ReturnType<typeof useQueryCache>
  key: ComputedRef<string>
  enabled: ComputedRef<boolean>
  gcTime: number
  staleTime: QueryStaleTime
  keepPreviousData: boolean
  refetchInterval?: import('vue').MaybeRefOrGetter<number | false | null | undefined>
  refetchOnMount: boolean | 'always'
  refetchOnWindowFocus: boolean | 'always'
  refetchOnReconnect: boolean | 'always'
}

export function applyQueryLifecycle<TQuery extends LifecycleQuery>(
  query: TQuery,
  opts: QueryLifecycleOptions,
): TQuery {
  const {
    cache,
    enabled,
    gcTime,
    key,
    keepPreviousData,
    refetchInterval,
    refetchOnMount,
    refetchOnReconnect,
    refetchOnWindowFocus,
    staleTime,
  } = opts

  const previousData = shallowRef()
  watch(query.data, (value) => {
    if (value != null)
      previousData.value = value
  }, { immediate: true })
  const isPlaceholderData = computed(() => {
    return keepPreviousData && query.data.value == null && previousData.value !== undefined
  })
  const displayData = computed(() => {
    return isPlaceholderData.value ? previousData.value : query.data.value
  })

  query.displayData = displayData
  query.isPlaceholderData = isPlaceholderData
  query.isPending = computed(() => query.status.value === 'pending' && query.data.value == null)
  query.isFetching = computed(() => query.status.value === 'pending')

  let release: (() => void) | undefined
  watch(key, (next) => {
    release?.()
    release = retainQuery(cache, next, gcTime, () => clearNuxtData(next))
  }, { immediate: true })
  if (getCurrentScope())
    onScopeDispose(() => release?.())

  watch(query.status, (status, previous) => {
    if (previous === 'pending' && status === 'success')
      markQueryFetched(cache, key.value)
  })

  watch(enabled, (next, previous) => {
    if (next && previous === false && isQueryStale(cache, key.value, staleTime))
      void query.refresh()
  })

  if (enabled.value && shouldRefetchOnMount(query, cache, key.value, staleTime, refetchOnMount)) {
    void query.refresh()
  }

  if (import.meta.client) {
    const visibility = useDocumentVisibility()
    watch(visibility, (state) => {
      if (state === 'visible')
        refetchIfAllowed(query, enabled.value, key.value, cache, staleTime, refetchOnWindowFocus)
    })

    useEventListener(window, 'online', () => {
      refetchIfAllowed(query, enabled.value, key.value, cache, staleTime, refetchOnReconnect)
    })
  }

  if (refetchInterval !== false && refetchInterval != null) {
    const intervalMs = computed(() => normalizeRefetchInterval(toValue(refetchInterval)))
    const interval = useIntervalFn(() => {
      if (enabled.value && intervalMs.value > 0)
        void query.refresh()
    }, intervalMs, { immediate: false })
    watch(intervalMs, (ms) => {
      if (ms > 0)
        interval.resume()
      else
        interval.pause()
    }, { immediate: true })
  }

  return query
}

function normalizeRefetchInterval(value: number | false | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0
}

function shouldRefetchOnMount(
  query: { data: { value: unknown }, refresh: () => Promise<void>, status: { value: string } },
  cache: ReturnType<typeof useQueryCache>,
  key: string,
  staleTime: QueryStaleTime,
  option: boolean | 'always',
): boolean {
  if (!option || query.status.value === 'pending')
    return false
  if (option === 'always')
    return true
  return hasResolvedQueryData(query) && isQueryStale(cache, key, staleTime)
}

function hasResolvedQueryData(query: { data: { value: unknown }, status: { value: string } }): boolean {
  return query.status.value === 'success' || query.data.value != null
}

function refetchIfAllowed(
  query: { refresh: () => Promise<void> },
  enabled: boolean,
  key: string,
  cache: ReturnType<typeof useQueryCache>,
  staleTime: QueryStaleTime,
  option: boolean | 'always',
) {
  if (!enabled || !option)
    return
  if (option === 'always' || isQueryStale(cache, key, staleTime))
    void query.refresh()
}
