import type { AvailableRouterMethod, NitroFetchRequest } from 'nitropack/types'
import type {
  AsyncData,
  FetchResult,
  UseFetchOptions,
} from 'nuxt/app'
import type { ComputedRef, MaybeRefOrGetter } from 'vue'
import type { QueryStaleTime } from '../cache'
import { useDocumentVisibility, useEventListener, useIntervalFn } from '@vueuse/core'
import { computed, getCurrentScope, onScopeDispose, shallowRef, toValue, watch } from 'vue'
import { clearNuxtData, useFetch } from '#app'
import { isQueryStale, markQueryFetched, retainQuery } from '../cache'
import { readNuxtData } from '../nuxt-data'
import { useQueryCache } from './useQueryCache'

type KeysOf<T> = Array<T extends T ? keyof T extends string ? keyof T : never : never>
type PickFrom<T, K extends Array<string>> = T extends Array<any>
  ? T
  : T extends Record<string, any>
    ? keyof T extends K[number]
      ? T
      : K[number] extends never
        ? T
        : Pick<T, K[number]>
    : T

export interface UseNuxtQueryOptions<
  ResT,
  DataT = ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = undefined,
  ReqT extends NitroFetchRequest = string & {},
  Method extends AvailableRouterMethod<ReqT> = AvailableRouterMethod<ReqT>,
> extends Omit<UseFetchOptions<ResT, DataT, PickKeys, DefaultT, ReqT, Method>, 'transform'> {
  key: MaybeRefOrGetter<string>
  transform?: (input: unknown) => DataT | Promise<DataT>
  enabled?: MaybeRefOrGetter<boolean>
  staleTime?: QueryStaleTime
  gcTime?: number
  keepPreviousData?: boolean
  refetchInterval?: MaybeRefOrGetter<number | false | null | undefined>
  refetchOnMount?: boolean | 'always'
  refetchOnWindowFocus?: boolean | 'always'
  refetchOnReconnect?: boolean | 'always'
}

export type NuxtQuery<DataT, ErrorT> = AsyncData<DataT, ErrorT> & {
  displayData: ComputedRef<DataT>
  isPlaceholderData: ComputedRef<boolean>
  isPending: ComputedRef<boolean>
  isFetching: ComputedRef<boolean>
}

export function useNuxtQuery<
  ResT = void,
  ErrorT = unknown,
  ReqT extends NitroFetchRequest = NitroFetchRequest,
  Method extends AvailableRouterMethod<ReqT> = ResT extends void
    ? 'get' extends AvailableRouterMethod<ReqT>
      ? AvailableRouterMethod<ReqT> & 'get'
      : AvailableRouterMethod<ReqT>
    : AvailableRouterMethod<ReqT>,
  _ResT = [ResT] extends [void] ? FetchResult<ReqT, Method> : ResT,
  DataT = _ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = undefined,
>(
  request: ReqT | MaybeRefOrGetter<ReqT>,
  opts: UseNuxtQueryOptions<_ResT, DataT, PickKeys, DefaultT, ReqT, Method>,
): NuxtQuery<DefaultT | PickFrom<DataT, PickKeys>, ErrorT | undefined>
export function useNuxtQuery<
  ResT = void,
  ErrorT = unknown,
  ReqT extends NitroFetchRequest = NitroFetchRequest,
  Method extends AvailableRouterMethod<ReqT> = ResT extends void
    ? 'get' extends AvailableRouterMethod<ReqT>
      ? AvailableRouterMethod<ReqT> & 'get'
      : AvailableRouterMethod<ReqT>
    : AvailableRouterMethod<ReqT>,
  _ResT = [ResT] extends [void] ? FetchResult<ReqT, Method> : ResT,
  DataT = _ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = DataT,
>(
  request: ReqT | MaybeRefOrGetter<ReqT>,
  opts: UseNuxtQueryOptions<_ResT, DataT, PickKeys, DefaultT, ReqT, Method>,
): NuxtQuery<DefaultT | PickFrom<DataT, PickKeys>, ErrorT | undefined>
export function useNuxtQuery(
  request: NitroFetchRequest | MaybeRefOrGetter<NitroFetchRequest>,
  opts: UseNuxtQueryOptions<any, any, any, any, any, any>,
): NuxtQuery<any, any> {
  const {
    enabled: enabledOption = true,
    gcTime = 5 * 60_000,
    keepPreviousData = true,
    refetchInterval,
    refetchOnMount = true,
    refetchOnReconnect = true,
    refetchOnWindowFocus = true,
    staleTime = 0,
    ...fetchOptions
  } = opts

  const cache = useQueryCache()
  const key = computed(() => toValue(opts.key))
  const enabled = computed(() => toValue(enabledOption) !== false)

  const query = useFetch(request as any, {
    ...fetchOptions,
    key,
    immediate: fetchOptions.immediate ?? enabled.value,
    // Nuxt's default dedupe is 'cancel' which aborts the in-flight request on
    // a concurrent same-key call — the server has usually already received
    // the cancelled request, so two sibling components mounting the same
    // query still produce two network hits. 'defer' makes the second mount
    // await the first promise instead.
    dedupe: fetchOptions.dedupe ?? 'defer',
    getCachedData: (cacheKey: string, nuxtApp: any, context: any) => {
      if (fetchOptions.getCachedData) {
        const cached = fetchOptions.getCachedData(cacheKey, nuxtApp, context)
        if (cached !== undefined)
          return cached
      }
      if (isQueryStale(cache, cacheKey, staleTime))
        return undefined
      return readNuxtData(nuxtApp, cacheKey)
    },
  } as any) as NuxtQuery<any, any>

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

  if (refetchOnMount === 'always' && enabled.value) {
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

  if (refetchInterval != null) {
    useIntervalFn(() => {
      if (enabled.value)
        void query.refresh()
    }, computed(() => toValue(refetchInterval) || 0), { immediate: false })
  }

  return query
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
