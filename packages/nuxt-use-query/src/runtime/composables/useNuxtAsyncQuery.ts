import type { AsyncDataOptions, NuxtApp } from 'nuxt/app'
import type { MaybeRefOrGetter } from 'vue'
import type { QueryStaleTime } from '../cache'
import type { QueryServerOption } from '../query-server-option'
import type { NuxtQuery } from './useNuxtQuery'
import { computed, ref, toValue } from 'vue'
import { useAsyncData } from '#app'
import { isQueryStale } from '../cache'
import { readNuxtData } from '../nuxt-data'
import { applyQueryLifecycle } from '../query-lifecycle'
import { createQuerySsrDeferredPayload, getQuerySsrDeadline, isQuerySsrDeferredPayload, isQuerySsrDeferredValue, resolveQueryServerOption, runWithQuerySsrDeadline } from '../query-server-option'
import { useQueryTelemetry } from '../query-telemetry'
import { useQueryCache } from './useQueryCache'

export type { QueryServerDeadline, QueryServerOption } from '../query-server-option'

// Handler-based sibling of `useNuxtQuery`. Where `useNuxtQuery` is bound to a
// URL (`useFetch`), this wraps an arbitrary async function via `useAsyncData`,
// so any non-REST data source — a typed command client, GraphQL, an RPC SDK,
// an in-memory snapshot — gets the same SWR cache, GC, refetch triggers, and
// `displayData` / `isPending` / `isFetching` surface. The handler's thrown
// error lands in `error` unchanged, so callers stop swallowing failures into
// empty states.

export interface UseNuxtAsyncQueryOptions<ResT, DataT = ResT>
  extends Omit<AsyncDataOptions<ResT, DataT>, 'getCachedData' | 'server'> {
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
  server?: QueryServerOption
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
    server: serverOption = true,
    staleTime = 0,
    ...asyncOptions
  } = opts

  const cache = useQueryCache()
  const telemetry = useQueryTelemetry()
  const resolvedServerOption = resolveQueryServerOption(serverOption)
  const ssrDeferred = ref(false)
  const key = computed(() => toValue(opts.key))
  const enabled = computed(() => toValue(enabledOption) !== false)

  const deadlineHandler = async (app: NuxtApp, context: NuxtAsyncQueryHandlerContext) => {
    if (!import.meta.server || resolvedServerOption.deadline == null)
      return handler(app, context)
    return runWithQuerySsrDeadline({
      deadline: resolvedServerOption.deadline,
      onDeferred: () => void (ssrDeferred.value = true),
      run: signal => handler(app, { signal }),
      signal: context.signal,
    })
  }

  const wrappedHandler = telemetry._tag === 'enabled'
    ? async (app: NuxtApp, context: NuxtAsyncQueryHandlerContext) => {
      const request = key.value
      const state = telemetry.start({
        key: request,
        request,
      })
      return deadlineHandler(app, context).then(
        (result) => {
          if (isQuerySsrDeferredValue(result)) {
            telemetry.finish({
              _tag: 'started',
              deadline: resolvedServerOption.deadline!,
              error: result.error,
              reason: 'ssr-deadline',
              state,
              status: 'deferred',
            })
          }
          else {
            telemetry.finish({ _tag: 'started', state, status: 'success' })
          }
          return result
        },
        (error) => {
          const deadline = getQuerySsrDeadline(error)
          telemetry.finish(deadline == null
            ? { _tag: 'started', error, state, status: 'error' }
            : { _tag: 'started', deadline, error, reason: 'ssr-deadline', state, status: 'deferred' })
          throw error
        },
      )
    }
    : deadlineHandler

  const query = useAsyncData<ResT, ErrorT, DataT>(
    () => key.value,
    wrappedHandler as NuxtAsyncQueryHandler<ResT>,
    {
      ...asyncOptions,
      enabled,
      immediate: asyncOptions.immediate ?? enabled.value,
      server: resolvedServerOption.server,
      transform: async (input: ResT) => {
        if (isQuerySsrDeferredValue(input))
          return createQuerySsrDeferredPayload() as DataT
        return asyncOptions.transform ? await asyncOptions.transform(input) : input as unknown as DataT
      },
      dedupe: asyncOptions.dedupe ?? 'defer',
      getCachedData: (cacheKey: string, app: any, context: any) => {
        if (asyncOptions.getCachedData) {
          const cached = asyncOptions.getCachedData(cacheKey, app, context)
          if (cached !== undefined && !isQuerySsrDeferredPayload(cached))
            return cached
        }
        if (isQueryStale(cache, cacheKey, staleTime))
          return undefined
        const cached = readNuxtData(app, cacheKey)
        return (isQuerySsrDeferredPayload(cached) ? undefined : cached) as DataT | undefined
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
    ssrDeferred,
  }) as unknown as NuxtQuery<DataT, ErrorT | undefined>
}
