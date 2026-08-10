import type { AsyncDataOptions, NuxtApp } from 'nuxt/app'
import type { MaybeRefOrGetter } from 'vue'
import type { QueryStaleTime } from '../cache'
import type { NuxtQuery } from './useNuxtQuery'
import { computed, toValue } from 'vue'
import { useAsyncData } from '#app'
import { isQueryStale } from '../cache'
import { readNuxtData } from '../nuxt-data'
import { applyQueryLifecycle } from '../query-lifecycle'
import { useQueryTelemetry } from '../query-telemetry'
import { useQueryCache } from './useQueryCache'

// Handler-based sibling of `useNuxtQuery`. Where `useNuxtQuery` is bound to a
// URL (`useFetch`), this wraps an arbitrary async function via `useAsyncData`,
// so any non-REST data source — a typed command client, GraphQL, an RPC SDK,
// an in-memory snapshot — gets the same SWR cache, GC, refetch triggers, and
// `displayData` / `isPending` / `isFetching` surface. The handler's thrown
// error lands in `error` unchanged, so callers stop swallowing failures into
// empty states.

export interface UseNuxtAsyncQueryOptions<ResT, DataT = ResT>
  extends Omit<AsyncDataOptions<ResT, DataT>, 'getCachedData'> {
  /** Required cache key. Reactive — the handler reruns when it changes. */
  key: MaybeRefOrGetter<string>
  enabled?: MaybeRefOrGetter<boolean>
  staleTime?: QueryStaleTime
  gcTime?: number
  keepPreviousData?: boolean
  refetchInterval?: MaybeRefOrGetter<number | false | null | undefined>
  refetchOnMount?: boolean | 'always'
  refetchOnWindowFocus?: boolean | 'always'
  refetchOnReconnect?: boolean | 'always'
  /** Escape hatch: runs before the SWR staleness check; `undefined` falls through. */
  getCachedData?: AsyncDataOptions<ResT, DataT>['getCachedData']
}

export interface NuxtAsyncQueryHandlerContext {
  signal: AbortSignal
}

export type NuxtAsyncQueryHandler<ResT> = (
  nuxtApp: NuxtApp,
  context: NuxtAsyncQueryHandlerContext,
) => Promise<ResT>

export function useNuxtAsyncQuery<ResT, DataT = ResT, ErrorT = unknown>(
  handler: NuxtAsyncQueryHandler<ResT>,
  opts: UseNuxtAsyncQueryOptions<ResT, DataT>,
): NuxtQuery<DataT, ErrorT | undefined> {
  const {
    enabled: enabledOption = true,
    gcTime = 5 * 60_000,
    keepPreviousData = true,
    refetchInterval,
    refetchOnMount = true,
    refetchOnReconnect = true,
    refetchOnWindowFocus = true,
    staleTime = 0,
    ...asyncOptions
  } = opts

  const cache = useQueryCache()
  const telemetry = useQueryTelemetry()
  const key = computed(() => toValue(opts.key))
  const enabled = computed(() => toValue(enabledOption) !== false)

  const wrappedHandler = telemetry._tag === 'enabled'
    ? async (app: NuxtApp, context: NuxtAsyncQueryHandlerContext) => {
      const request = key.value
      const state = telemetry.start({
        key: request,
        request,
      })
      return handler(app, context).then(
        (result) => {
          telemetry.finish({ _tag: 'started', state, status: 'success' })
          return result
        },
        (error) => {
          telemetry.finish({ _tag: 'started', error, state, status: 'error' })
          throw error
        },
      )
    }
    : handler

  const query = useAsyncData<ResT, ErrorT, DataT>(
    () => key.value,
    wrappedHandler,
    {
      ...asyncOptions,
      enabled,
      immediate: asyncOptions.immediate ?? enabled.value,
      dedupe: asyncOptions.dedupe ?? 'defer',
      getCachedData: (cacheKey: string, app: any, context: any) => {
        if (asyncOptions.getCachedData) {
          const cached = asyncOptions.getCachedData(cacheKey, app, context)
          if (cached !== undefined)
            return cached
        }
        if (isQueryStale(cache, cacheKey, staleTime))
          return undefined
        return readNuxtData(app, cacheKey)
      },
    },
  ) as unknown as NuxtQuery<DataT, ErrorT | undefined>

  return applyQueryLifecycle(query as any, {
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
  }) as unknown as NuxtQuery<DataT, ErrorT | undefined>
}
