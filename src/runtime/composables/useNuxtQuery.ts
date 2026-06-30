import type { InternalApi, NitroFetchRequest } from 'nitropack/types'
import type {
  AsyncData,
  UseFetchOptions,
} from 'nuxt/app'
import type { ComputedRef, MaybeRefOrGetter } from 'vue'
import type { QueryStaleTime } from '../cache'
import type { QueryTelemetryFinishEvent, QueryTelemetryStartEvent } from '../telemetry'
import { computed, toValue } from 'vue'
import { useFetch, useNuxtApp, useRuntimeConfig } from '#app'
import { isQueryStale } from '../cache'
import { readNuxtData } from '../nuxt-data'
import { applyQueryLifecycle } from '../query-lifecycle'
import { callTelemetryHook, NUXT_USE_QUERY_TELEMETRY_HOOKS } from '../telemetry'
import { useQueryCache } from './useQueryCache'

export type KeysOf<T> = Array<T extends T ? keyof T extends string ? keyof T : never : never>
type PickFrom<T, K extends Array<string>> = T extends Array<any>
  ? T
  : T extends Record<string, any>
    ? keyof T extends K[number]
      ? T
      : K[number] extends never
        ? T
        : Pick<T, K[number]>
    : T

type LooseFetchRequest = string & {}

type InternalRouteResponse<ReqT extends NitroFetchRequest> = ReqT extends keyof InternalApi
  ? 'get' extends keyof InternalApi[ReqT]
    ? InternalApi[ReqT]['get']
    : 'default' extends keyof InternalApi[ReqT]
      ? InternalApi[ReqT]['default']
      : unknown
  : unknown

export interface UseNuxtQueryOptions<
  ResT,
  DataT = ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = undefined,
> extends Omit<UseFetchOptions<ResT, DataT, PickKeys, DefaultT, LooseFetchRequest, any>, 'transform'> {
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

const QUERY_TELEMETRY_STATE = Symbol('nuxt-use-query-state')

interface QueryTelemetryRuntimeConfig {
  public?: {
    nuxtUseQuery?: {
      telemetry?: {
        enabled?: unknown
      }
    }
  }
}

interface QueryTelemetryState {
  finished: boolean
  key: string
  request: string
  startedAt: number
}

export function useNuxtQuery<
  ResT = void,
  ErrorT = unknown,
  ReqT extends NitroFetchRequest = string & {},
  _ResT = [ResT] extends [void] ? InternalRouteResponse<ReqT> : ResT,
  DataT = _ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = undefined,
>(
  request: ReqT | MaybeRefOrGetter<ReqT>,
  opts: UseNuxtQueryOptions<_ResT, DataT, PickKeys, DefaultT>,
): NuxtQuery<DefaultT | PickFrom<DataT, PickKeys>, ErrorT | undefined>
export function useNuxtQuery<
  ResT = void,
  ErrorT = unknown,
  ReqT extends NitroFetchRequest = string & {},
  _ResT = [ResT] extends [void] ? InternalRouteResponse<ReqT> : ResT,
  DataT = _ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = DataT,
>(
  request: ReqT | MaybeRefOrGetter<ReqT>,
  opts: UseNuxtQueryOptions<_ResT, DataT, PickKeys, DefaultT>,
): NuxtQuery<DefaultT | PickFrom<DataT, PickKeys>, ErrorT | undefined>
export function useNuxtQuery(
  request: NitroFetchRequest | MaybeRefOrGetter<NitroFetchRequest>,
  opts: UseNuxtQueryOptions<any, any, any, any>,
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
  const nuxtApp = useNuxtApp()
  const telemetryEnabled = isQueryTelemetryEnabled()
  const key = computed(() => toValue(opts.key))
  const enabled = computed(() => toValue(enabledOption) !== false)

  function emitQueryStart(context: unknown): void {
    if (!telemetryEnabled)
      return
    const startedAt = Date.now()
    const state: QueryTelemetryState = {
      finished: false,
      key: key.value,
      request: describeQueryRequest(request),
      startedAt,
    }
    setQueryTelemetryState(context, state)
    const event: QueryTelemetryStartEvent = {
      client: import.meta.client,
      key: state.key,
      request: state.request,
      server: import.meta.server,
      startedAt,
    }
    callTelemetryHook(nuxtApp.hooks, NUXT_USE_QUERY_TELEMETRY_HOOKS.queryStart, event)
  }

  function emitQueryFinish(status: 'error' | 'success', context: unknown, error?: unknown): void {
    if (!telemetryEnabled)
      return
    const state = getQueryTelemetryState(context)
    if (state?.finished)
      return
    if (state)
      state.finished = true
    const endedAt = Date.now()
    const startedAt = state?.startedAt ?? endedAt
    const event: QueryTelemetryFinishEvent = {
      client: import.meta.client,
      durationMs: Math.max(0, endedAt - startedAt),
      endedAt,
      error,
      key: state?.key ?? key.value,
      request: state?.request ?? describeQueryRequest(request),
      server: import.meta.server,
      startedAt,
      status,
    }
    callTelemetryHook(nuxtApp.hooks, NUXT_USE_QUERY_TELEMETRY_HOOKS.queryFinish, event)
  }

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
    onRequest: async (context: unknown) => {
      emitQueryStart(context)
      try {
        await callFetchHook(fetchOptions.onRequest, context)
      }
      catch (error) {
        emitQueryFinish('error', context, error)
        throw error
      }
    },
    onRequestError: async (context: any) => {
      try {
        await callFetchHook(fetchOptions.onRequestError, context)
      }
      finally {
        emitQueryFinish('error', context, context?.error)
      }
    },
    onResponse: async (context: unknown) => {
      try {
        await callFetchHook(fetchOptions.onResponse, context)
      }
      catch (error) {
        emitQueryFinish('error', context, error)
        throw error
      }
      if (!isPendingResponseError(context, fetchOptions.ignoreResponseError))
        emitQueryFinish('success', context)
    },
    onResponseError: async (context: any) => {
      try {
        await callFetchHook(fetchOptions.onResponseError, context)
      }
      finally {
        emitQueryFinish('error', context, toResponseError(context))
      }
    },
  } as any) as NuxtQuery<any, any>

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
  }) as NuxtQuery<any, any>
}

function isQueryTelemetryEnabled(): boolean {
  try {
    const config = useRuntimeConfig() as QueryTelemetryRuntimeConfig
    return config.public?.nuxtUseQuery?.telemetry?.enabled === true
  }
  catch {
    return false
  }
}

async function callFetchHook(hook: unknown, context: unknown): Promise<void> {
  if (hook == null)
    return
  if (Array.isArray(hook)) {
    for (const fn of hook)
      await callFetchHook(fn, context)
    return
  }
  await (hook as (context: unknown) => void | Promise<void>)(context)
}

function setQueryTelemetryState(context: unknown, state: QueryTelemetryState): void {
  if (context && typeof context === 'object')
    (context as Record<typeof QUERY_TELEMETRY_STATE, QueryTelemetryState>)[QUERY_TELEMETRY_STATE] = state
}

function getQueryTelemetryState(context: unknown): QueryTelemetryState | undefined {
  if (!context || typeof context !== 'object')
    return undefined
  return (context as Partial<Record<typeof QUERY_TELEMETRY_STATE, QueryTelemetryState>>)[QUERY_TELEMETRY_STATE]
}

// ofetch only sets `context.error` for request-side failures; on an HTTP response
// error the interceptor receives a bare `Response` instead. Emitting that raw
// `Response` as the telemetry error is useless to log or report (it stringifies to
// `[object Response]` with no message). Synthesize a real `Error` from the response
// when ofetch hasn't supplied one, mirroring ofetch's own FetchError shape so
// downstream consumers can still read `status`/`data`/`response`.
function toResponseError(context: any): unknown {
  if (context?.error)
    return context.error
  const response = context?.response
  if (!response)
    return undefined
  const method = String(context?.options?.method ?? 'GET').toUpperCase()
  const url = describeQueryRequest(context?.request)
  const error = new Error(`[${method}] "${url}": ${response.status} ${response.statusText}`) as Error & Record<string, unknown>
  error.name = 'FetchError'
  error.status = response.status
  error.statusCode = response.status
  error.statusText = response.statusText
  error.statusMessage = response.statusText
  error.data = (response as { _data?: unknown })._data
  error.response = response
  return error
}

function isPendingResponseError(context: unknown, ignoreResponseError: unknown): boolean {
  if (ignoreResponseError === true || !context || typeof context !== 'object')
    return false
  const response = (context as { response?: { ok?: boolean, status?: unknown } }).response
  if (!response)
    return false
  const status = Number(response.status)
  return response.ok === false || (Number.isFinite(status) && status >= 400)
}

function describeQueryRequest(request: NitroFetchRequest | MaybeRefOrGetter<NitroFetchRequest>): string {
  const value = toValue(request)
  if (typeof value === 'string')
    return value
  if (value instanceof URL)
    return value.href
  if (value && typeof value === 'object' && 'url' in value)
    return String((value as { url: unknown }).url)
  return '[unknown]'
}
