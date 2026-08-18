import type { ComputedRef, MaybeRefOrGetter } from 'vue'
import type { z } from 'zod'
import type {
  NuxtRpcClientOptions,
  NuxtRpcError,
  NuxtRpcKey,
  NuxtRpcOperationContext,
  NuxtRpcQueryOperation,
} from '../rpc/core'
import type { KeysOf, NuxtQuery, UseNuxtQueryOptions } from './useNuxtQuery'
import { computed, toValue, watch } from 'vue'
import { useNuxtApp, useRequestFetch } from '#app'
import {
  createNuxtRpcClient,
  normalizeNuxtRpcError,
  parseNuxtRpcResponse,
  resolveNuxtRpcQueryRequest,
  serializeInvalidNuxtRpcQueryKey,
  serializeNuxtRpcKey,
} from '../rpc/core'
import { useNuxtQuery } from './useNuxtQuery'
import { invalidateNuxtQueries } from './useQueryCache'

/**
 * Invalidate cached queries for an RPC operation (or a raw key) by its serialized
 * cache key. The type-safe alternative to hand-writing the prefix string, which
 * otherwise has to mirror `serializeNuxtRpcKey` exactly (including its per-segment
 * `encodeURIComponent`). Prefix-matches, so it also catches keys nested under it.
 * Resolves only after matching active refetches settle and forwards refresh
 * failures as a rejected Promise.
 */

export function invalidateNuxtRpc(operationOrKey: NuxtRpcKey | { key: NuxtRpcKey }): Promise<void> {
  const isOperation = typeof operationOrKey === 'object' && operationOrKey !== null && 'key' in operationOrKey
  const key = isOperation ? operationOrKey.key : operationOrKey
  return invalidateNuxtQueries(serializeNuxtRpcKey(key))
}

export interface NuxtRpcQueryErrorEvent {
  operation: NuxtRpcOperationContext
  error: NuxtRpcError
  /**
   * How long the failing request was in flight. Undefined when the failure
   * arrived with the server-rendered payload, because the request ran in the
   * previous runtime.
   */
  durationMs?: number
}

// `DefaultT` must stay a generic so the `default` factory drives its own
// inference. Without it `DefaultT` pins to `undefined` and `default` collapses
// to `() => Ref<undefined, undefined> | undefined`, rejecting every real value.
export type UseNuxtRpcQueryOptions<TData, DefaultT = undefined> = Omit<
  UseNuxtQueryOptions<TData, TData, KeysOf<TData>, DefaultT>,
  'body' | 'key' | 'method' | 'query' | 'transform'
> & {
  /**
   * Called once for each failure of this query. The imperative client hook of
   * the same name covers `rpc.query` / `rpc.execute` only, so without this a
   * reactive query failure reaches no handler.
   */
  onError?: (event: NuxtRpcQueryErrorEvent) => void
}

export function useNuxtRpcQuery<
  TResponseSchema extends z.ZodTypeAny,
  TQuery = undefined,
  DefaultT = undefined,
>(
  operation: MaybeRefOrGetter<NuxtRpcQueryOperation<TResponseSchema, TQuery>>,
  options: UseNuxtRpcQueryOptions<z.output<TResponseSchema>, DefaultT> = {},
) {
  const resolved = () => toValue(operation)
  const request = computed(() => resolveQueryRequestState(resolved()))
  const userOnRequest = options.onRequest
  // `onError` belongs to this composable, not to `useFetch`. Strip it so it
  // never reaches the fetch options.
  const { onError, ...queryOptions } = options
  const query = (useNuxtQuery as any)(() => resolved().path, {
    ...queryOptions,
    key: () => request.value._tag === 'ok' ? request.value.request.key : request.value.key,
    method: computed(() => request.value._tag === 'ok' ? request.value.request.method : request.value.method),
    query: computed(() => resolved().query),
    body: computed(() => request.value._tag === 'ok' ? request.value.request.body : undefined),
    onRequest: [
      () => {
        if (request.value._tag === 'err')
          throw request.value.error
      },
      ...(Array.isArray(userOnRequest) ? userOnRequest : userOnRequest == null ? [] : [userOnRequest]),
    ],
    // Same parse-and-normalize the imperative client uses, so a successful
    // payload that fails its schema surfaces an identical `NuxtRpcError`.
    transform: (payload: unknown) => parseNuxtRpcResponse(resolved().response, payload),
  } as UseNuxtQueryOptions<z.output<TResponseSchema>>) as NuxtQuery<DefaultT | z.output<TResponseSchema>, NuxtRpcError | undefined>

  // `transform` only runs on a successful payload, so on an HTTP / timeout /
  // network failure `useFetch` parks the *raw* `FetchError` in `error.value` —
  // leaving the reactive path inconsistent with `querySafe`, which returns a
  // tagged `NuxtRpcError`. Wrap `error` so every consumer sees one shape
  // (`NuxtRpcError`) regardless of which path produced the failure.
  // A *writable* computed: reads normalize the underlying error, writes pass
  // straight through to the original ref. This preserves AsyncData's writable
  // `error` contract — a consumer (or Nuxt's own refresh) clearing
  // `error.value` still writes through and re-reads as cleared, rather than
  // hitting a no-op setter on a readonly computed.
  const rawError = query.error
  // Nuxt's AsyncData catches a thrown plain-object `NuxtRpcError` and runs it
  // through `createError`, which can discard our discriminant/issue fields.
  // Normalize the owned ref itself, not only the facade below: awaiting a
  // Nuxt AsyncData thenable resolves to a second facade over this same ref, so
  // a getter-only wrapper on the outer thenable would otherwise disappear.
  watch([rawError, request], ([value, current]) => {
    if (value == null)
      return
    const normalized = normalizeNuxtRpcQueryError(value, current)
    if (normalized !== value)
      rawError.value = normalized
  }, { flush: 'sync', immediate: true })
  query.error = computed({
    get: () => (rawError.value == null ? undefined : normalizeNuxtRpcQueryError(rawError.value, request.value)),
    set: value => void (rawError.value = value),
  }) as typeof query.error

  if (onError)
    useQueryErrorReporter(query, rawError, resolved, request, onError)

  return query
}

/**
 * Report each failure of a reactive query once.
 *
 * The hook runs outside server rendering. A failure raised during SSR is
 * transferred in the payload and reported on hydration, so a hook that ran in
 * both runtimes would report the same failure twice.
 */
function useQueryErrorReporter(
  query: { status?: { value: string } },
  rawError: { value: unknown },
  resolved: () => NuxtRpcQueryOperation<z.ZodTypeAny, unknown>,
  request: ComputedRef<ReturnType<typeof resolveQueryRequestState>>,
  onError: (event: NuxtRpcQueryErrorEvent) => void,
): void {
  if (import.meta.server)
    return

  let startedAt: number | undefined
  if (query.status) {
    watch(() => query.status!.value, (status) => {
      if (status === 'pending')
        startedAt = Date.now()
    })
  }

  // A normalized error keeps its identity across reads, so object identity is
  // what separates a new failure from a re-read of the same one.
  const reported = new WeakSet<object>()
  watch(rawError, (value) => {
    if (value == null || typeof value !== 'object')
      return
    if (reported.has(value))
      return
    reported.add(value)
    const durationMs = startedAt == null ? undefined : Date.now() - startedAt
    startedAt = undefined
    onError({
      durationMs,
      error: normalizeNuxtRpcQueryError(value, request.value),
      operation: describeQueryOperation(resolved()),
    })
  }, { immediate: true })
}

function describeQueryOperation(operation: NuxtRpcQueryOperation<z.ZodTypeAny, unknown>): NuxtRpcOperationContext {
  return {
    kind: 'query',
    key: operation.key,
    method: operation.method === 'POST' ? 'POST' : 'GET',
    path: operation.path,
  }
}

function normalizeNuxtRpcQueryError(
  value: unknown,
  request: ReturnType<typeof resolveQueryRequestState>,
): NuxtRpcError {
  if (request._tag === 'err')
    return request.error

  const direct = normalizeNuxtRpcError(value)
  // Already tagged (including a response-validation object repaired by the
  // watcher on its previous pass): preserve identity and avoid a write loop.
  if (direct === value)
    return direct

  // Nuxt's `createError` keeps the original ZodError as `cause` when a plain
  // response-validation object is thrown from `transform`, but drops that
  // object's discriminant. Recover it before the H3Error's synthetic 500 can
  // be mistaken for a fetch failure. The repaired plain object is written back
  // into payload errors by the watcher above, so SSR hydration keeps the tag.
  const cause = value && typeof value === 'object' && 'cause' in value
    ? (value as { cause?: unknown }).cause
    : undefined
  const canRecoverWrappedValidation = direct.type !== 'fetch'
    || (direct.response == null && direct.data === undefined)
  if (cause != null && canRecoverWrappedValidation) {
    const fromCause = normalizeNuxtRpcError(cause, 'response-validation')
    if (fromCause.type === 'response-validation')
      return fromCause
  }
  return direct
}

function resolveQueryRequestState(
  operation: NuxtRpcQueryOperation<z.ZodTypeAny, unknown>,
) {
  try {
    return {
      _tag: 'ok' as const,
      request: resolveNuxtRpcQueryRequest(operation),
    }
  }
  catch (error) {
    const normalized = normalizeNuxtRpcError(error, 'request-validation')
    return {
      _tag: 'err' as const,
      error: normalized,
      key: serializeInvalidNuxtRpcQueryKey(operation, normalized),
      method: operation.method === 'POST' ? 'POST' as const : 'GET' as const,
    }
  }
}

export interface UseNuxtRpcOptions {
  fetch?: NuxtRpcClientOptions['fetch']
  onError?: NuxtRpcClientOptions['onError']
  onSuccess?: NuxtRpcClientOptions['onSuccess']
  onSettled?: NuxtRpcClientOptions['onSettled']
}

export function useNuxtRpc(options: UseNuxtRpcOptions = {}) {
  const nuxtApp = useNuxtApp()
  // RPC callbacks resolve asynchronously, often outside the Vue setup context
  // that owned the original call (asyncData refresh, watchers, microtasks).
  // Run them through `nuxtApp.runWithContext` so consumers can use composables
  // like `useToast` / `useRoute` inside `onError` without
  // "inject() can only be used inside setup()" warnings.
  const withContext = <TEvent>(cb?: (event: TEvent) => void | Promise<void>) =>
    cb ? (event: TEvent) => nuxtApp.runWithContext(() => cb(event)) : undefined
  return createNuxtRpcClient({
    fetch: options.fetch ?? resolveNuxtRpcFetch(nuxtApp),
    onError: withContext(options.onError),
    onSettled: withContext(options.onSettled),
    onSuccess: withContext(options.onSuccess),
  })
}

function resolveNuxtRpcFetch(nuxtApp: ReturnType<typeof useNuxtApp>): NuxtRpcClientOptions['fetch'] {
  const appFetch = (nuxtApp as { $fetch?: unknown }).$fetch
  if (typeof appFetch === 'function')
    return appFetch as NuxtRpcClientOptions['fetch']
  if (import.meta.server)
    return useRequestFetch() as NuxtRpcClientOptions['fetch']
  return globalThis.$fetch as NuxtRpcClientOptions['fetch']
}
