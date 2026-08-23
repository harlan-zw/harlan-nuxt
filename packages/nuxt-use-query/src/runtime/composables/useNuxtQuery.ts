import type { $Fetch } from 'nitropack'
import type { InternalApi, NitroFetchRequest } from 'nitropack/types'
import type {
  AsyncData,
  UseFetchOptions,
} from 'nuxt/app'
import type { ComputedRef, MaybeRefOrGetter } from 'vue'
import type { QueryStaleTime } from '../cache'
import type { QueryServerOption } from '../query-server-option'
import type { QueryTelemetryState } from '../query-telemetry'
import { computed, ref, toValue } from 'vue'
import { useFetch, useRequestFetch } from '#app'
import { isQueryStale } from '../cache'
import { readNuxtData } from '../nuxt-data'
import { applyQueryLifecycle } from '../query-lifecycle'
import { createQuerySsrDeferredPayload, getQuerySsrDeadline, isQuerySsrDeferredPayload, isQuerySsrDeferredValue, resolveQueryServerOption, runWithQuerySsrDeadline } from '../query-server-option'
import { useQueryTelemetry } from '../query-telemetry'
import { useQueryCache } from './useQueryCache'

export type { QueryServerDeadline, QueryServerOption } from '../query-server-option'

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
> extends Omit<UseFetchOptions<ResT, DataT, PickKeys, DefaultT, LooseFetchRequest, any>, 'server' | 'transform'> {
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
  server?: QueryServerOption
}

export type NuxtQuery<DataT, ErrorT> = AsyncData<DataT, ErrorT> & {
  displayData: ComputedRef<DataT>
  isPlaceholderData: ComputedRef<boolean>
  isPending: ComputedRef<boolean>
  isFetching: ComputedRef<boolean>
}

const QUERY_TELEMETRY_STATE = Symbol('nuxt-use-query-state')

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
    server: serverOption = true,
    staleTime = 0,
    ...fetchOptions
  } = opts

  const cache = useQueryCache()
  const telemetry = useQueryTelemetry()
  const resolvedServerOption = resolveQueryServerOption(serverOption)
  const ssrDeferred = ref(false)
  const key = computed(() => toValue(opts.key))
  const enabled = computed(() => toValue(enabledOption) !== false)
  const activeTelemetryStates = new Set<QueryTelemetryState>()

  function emitQueryStart(context: unknown): void {
    if (telemetry._tag === 'disabled')
      return
    const state = telemetry.start({
      key: key.value,
      request: describeQueryRequest(request),
    })
    activeTelemetryStates.add(state)
    setQueryTelemetryState(context, state)
  }

  function emitQueryFinish(status: 'error' | 'success', context: unknown, error?: unknown): void {
    if (telemetry._tag === 'disabled')
      return
    const state = getQueryTelemetryState(context)
    if (state)
      activeTelemetryStates.delete(state)
    const deadline = getQuerySsrDeadline(error)
    const finish = deadline == null
      ? { error, status }
      : { deadline, error, reason: 'ssr-deadline' as const, status: 'deferred' as const }
    telemetry.finish(state
      ? { _tag: 'started', state, ...finish }
      : {
          _tag: 'unstarted',
          descriptor: {
            key: key.value,
            request: describeQueryRequest(request),
          },
          ...finish,
        })
  }

  function emitQueryDeferred(deadline: number, error: unknown): void {
    if (telemetry._tag === 'disabled')
      return
    const state = activeTelemetryStates.values().next().value
    if (state)
      activeTelemetryStates.delete(state)
    telemetry.finish(state
      ? { _tag: 'started', deadline, error, reason: 'ssr-deadline', state, status: 'deferred' }
      : {
          _tag: 'unstarted',
          deadline,
          descriptor: {
            key: key.value,
            request: describeQueryRequest(request),
          },
          error,
          reason: 'ssr-deadline',
          status: 'deferred',
        })
  }

  const telemetryFetchOptions = telemetry._tag === 'enabled'
    ? {
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
      }
    : undefined

  const deadlineFetch = import.meta.server && resolvedServerOption.deadline != null
    ? createQueryDeadlineFetch(
        (fetchOptions.$fetch as unknown as QueryFetch | undefined) ?? (useRequestFetch() as unknown as QueryFetch),
        resolvedServerOption.deadline,
        (error) => {
          ssrDeferred.value = true
          emitQueryDeferred(resolvedServerOption.deadline!, error)
        },
      )
    : fetchOptions.$fetch

  const query = useFetch(request as any, {
    ...fetchOptions,
    ...(deadlineFetch == null ? {} : { $fetch: deadlineFetch }),
    enabled,
    key,
    immediate: fetchOptions.immediate ?? enabled.value,
    server: resolvedServerOption.server,
    transform: (input: unknown) => isQuerySsrDeferredValue(input)
      ? createQuerySsrDeferredPayload()
      : fetchOptions.transform ? fetchOptions.transform(input) : input,
    // Nuxt's default dedupe is 'cancel' which aborts the in-flight request on
    // a concurrent same-key call — the server has usually already received
    // the cancelled request, so two sibling components mounting the same
    // query still produce two network hits. 'defer' makes the second mount
    // await the first promise instead.
    dedupe: fetchOptions.dedupe ?? 'defer',
    getCachedData: (cacheKey: string, nuxtApp: any, context: any) => {
      if (fetchOptions.getCachedData) {
        const cached = fetchOptions.getCachedData(cacheKey, nuxtApp, context)
        if (cached !== undefined && !isQuerySsrDeferredPayload(cached))
          return cached
      }
      if (isQueryStale(cache, cacheKey, staleTime))
        return undefined
      const cached = readNuxtData(nuxtApp, cacheKey)
      return isQuerySsrDeferredPayload(cached) ? undefined : cached
    },
    ...telemetryFetchOptions,
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
    ssrDeferred,
  }) as NuxtQuery<any, any>
}

type QueryFetch = (request: unknown, options?: Record<string, any>) => Promise<unknown>

function createQueryDeadlineFetch(fetch: QueryFetch, deadline: number, onDeferred: (error: unknown) => void): $Fetch {
  return (async (request: unknown, options: Record<string, any> = {}) => {
    const { $fetch: _ignored, signal = new AbortController().signal, ...fetchOptions } = options
    return runWithQuerySsrDeadline({
      deadline,
      onDeferred,
      run: deadlineSignal => fetch(request as any, { ...fetchOptions, signal: deadlineSignal }),
      signal,
    })
  }) as $Fetch
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
