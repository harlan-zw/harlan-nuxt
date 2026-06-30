import type { AsyncDataOptions } from 'nuxt/app'
import type { MaybeRefOrGetter } from 'vue'
import type { QueryStaleTime } from '../cache'
import type { QueryTelemetryFinishEvent, QueryTelemetryStartEvent } from '../telemetry'
import type { NuxtQuery } from './useNuxtQuery'
import { computed, toValue } from 'vue'
import { useAsyncData, useNuxtApp, useRuntimeConfig } from '#app'
import { isQueryStale } from '../cache'
import { readNuxtData } from '../nuxt-data'
import { applyQueryLifecycle } from '../query-lifecycle'
import { callTelemetryHook, NUXT_USE_QUERY_TELEMETRY_HOOKS } from '../telemetry'
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

export function useNuxtAsyncQuery<ResT, DataT = ResT, ErrorT = unknown>(
  handler: (ctx?: any) => Promise<ResT>,
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
  const nuxtApp = useNuxtApp()
  const telemetryEnabled = isQueryTelemetryEnabled()
  const key = computed(() => toValue(opts.key))
  const enabled = computed(() => toValue(enabledOption) !== false)

  const wrappedHandler = telemetryEnabled
    ? async (ctx?: any) => {
      const startedAt = Date.now()
      const startEvent: QueryTelemetryStartEvent = {
        client: import.meta.client,
        key: key.value,
        request: key.value,
        server: import.meta.server,
        startedAt,
      }
      callTelemetryHook(nuxtApp.hooks, NUXT_USE_QUERY_TELEMETRY_HOOKS.queryStart, startEvent)
      return handler(ctx).then(
        (result) => {
          emitFinish('success', startedAt, key.value)
          return result
        },
        (error) => {
          emitFinish('error', startedAt, key.value, error)
          throw error
        },
      )
    }
    : handler

  function emitFinish(status: 'error' | 'success', startedAt: number, request: string, error?: unknown): void {
    const endedAt = Date.now()
    const event: QueryTelemetryFinishEvent = {
      client: import.meta.client,
      durationMs: Math.max(0, endedAt - startedAt),
      endedAt,
      error,
      key: request,
      request,
      server: import.meta.server,
      startedAt,
      status,
    }
    callTelemetryHook(nuxtApp.hooks, NUXT_USE_QUERY_TELEMETRY_HOOKS.queryFinish, event)
  }

  const query = useAsyncData<ResT, ErrorT, DataT>(
    () => key.value,
    wrappedHandler,
    {
      ...asyncOptions,
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

function isQueryTelemetryEnabled(): boolean {
  try {
    const config = useRuntimeConfig() as {
      public?: { nuxtUseQuery?: { telemetry?: { enabled?: unknown } } }
    }
    return config.public?.nuxtUseQuery?.telemetry?.enabled === true
  }
  catch {
    return false
  }
}
