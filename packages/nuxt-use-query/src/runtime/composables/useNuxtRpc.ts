import type { ComputedRef, MaybeRefOrGetter } from 'vue'
import type {
  NuxtRpcClientOptions,
  NuxtRpcError,
  NuxtRpcKey,
  NuxtRpcOperationContext,
  NuxtRpcQueryOperation,
  NuxtRpcResponseValidation,
  NuxtRpcSchema,
  NuxtRpcSchemaOutput,
} from '../rpc/core'
import type { KeysOf, NuxtQuery, UseNuxtQueryOptions } from './useNuxtQuery'
import { computed, toValue, watch } from 'vue'
import { useNuxtApp, useRequestFetch } from '#app'
import {
  createNuxtRpcClient,
  normalizeNuxtRpcError,
  parseNuxtRpcResponse,
  resolveNuxtRpcQueryRequest,
  resolveNuxtRpcResponseValidation,
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
  /**
   * Set only when a lenient response-validation mismatch was recovered: the
   * query still resolved to `'success'` with the raw payload instead of
   * failing. Absent (not `false`) for every other error event.
   */
  recovered?: true
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
  /** Default response validation mode for this query. The operation's own `responseValidation` wins over this. */
  responseValidation?: NuxtRpcResponseValidation
  /**
   * Resolves an `'auto'` `responseValidation` to a concrete mode. Defaults to
   * reading Nuxt's `import.meta.dev` (`true` in a dev build ⇒ `strict`,
   * `false` in production ⇒ `lenient`). Override for tests, or if this
   * query's dev/prod signal isn't `import.meta.dev`.
   */
  isDev?: () => boolean
}

export function useNuxtRpcQuery<
  TResponseSchema extends NuxtRpcSchema,
  TQuery = undefined,
  DefaultT = undefined,
>(
  operation: MaybeRefOrGetter<NuxtRpcQueryOperation<TResponseSchema, TQuery>>,
  options: UseNuxtRpcQueryOptions<NuxtRpcSchemaOutput<TResponseSchema>, DefaultT> = {},
) {
  const resolved = () => toValue(operation)
  const request = computed(() => resolveQueryRequestState(resolved()))
  const userOnRequest = options.onRequest
  // `onError`, `responseValidation`, and `isDev` belong to this composable,
  // not to `useFetch`. Strip them so they never reach the fetch options.
  const { onError, responseValidation: scopeResponseValidation, isDev: scopeIsDev, ...queryOptions } = options
  // Tracks when the current attempt's request left, purely to give a recovered
  // mismatch (reported from `transform` below) a `durationMs`. Reset once read
  // so a later mismatch on a request whose timing hook never ran (e.g. a
  // direct `transform` call in a test) reports `undefined` instead of a stale
  // value.
  let requestStartedAt: number | undefined
  const query = (useNuxtQuery as any)(() => resolved().path, {
    ...queryOptions,
    key: () => request.value._tag === 'ok' ? request.value.request.key : request.value.key,
    method: computed(() => request.value._tag === 'ok' ? request.value.request.method : request.value.method),
    query: computed(() => resolved().query),
    body: computed(() => request.value._tag === 'ok' ? request.value.request.body : undefined),
    onRequest: [
      () => {
        requestStartedAt = Date.now()
        if (request.value._tag === 'err')
          throw request.value.error
      },
      ...(Array.isArray(userOnRequest) ? userOnRequest : userOnRequest == null ? [] : [userOnRequest]),
    ],
    // Same parse-and-normalize the imperative client uses, so a successful
    // payload that fails its schema surfaces an identical `NuxtRpcError`.
    // Lenient mode (operation wins over this composable's `responseValidation`
    // scope option) reports the mismatch and hands the raw payload through
    // instead of throwing.
    //
    // `onMismatch` reports the recovered mismatch through this composable's
    // own `onError` (not `useQueryErrorReporter` below, which only watches
    // genuine failures). It fires unconditionally, on whichever runtime
    // actually ran the fetch — a recovered mismatch never throws, so it never
    // reaches Nuxt's AsyncData error/payload machinery the way a real failure
    // does, and gating this on `import.meta.client` (like the error watcher
    // does) would leave every SSR-recovered mismatch unreported: there is no
    // later hydration re-run of `transform` to catch it on the client.
    transform: (payload: unknown) => parseNuxtRpcResponse(resolved().response, payload, {
      mode: resolveNuxtRpcResponseValidation(resolved().responseValidation, scopeResponseValidation, scopeIsDev),
      path: resolved().path,
      onMismatch: (error) => {
        const durationMs = requestStartedAt == null ? undefined : Date.now() - requestStartedAt
        requestStartedAt = undefined
        reportRecoveredQueryMismatch(onError, {
          durationMs,
          error,
          operation: describeQueryOperation(resolved()),
          recovered: true,
        })
      },
    }),
  } as UseNuxtQueryOptions<NuxtRpcSchemaOutput<TResponseSchema>>) as NuxtQuery<DefaultT | NuxtRpcSchemaOutput<TResponseSchema>, NuxtRpcError | undefined>

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
  resolved: () => NuxtRpcQueryOperation<NuxtRpcSchema, unknown>,
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

function describeQueryOperation(operation: NuxtRpcQueryOperation<NuxtRpcSchema, unknown>): NuxtRpcOperationContext {
  return {
    kind: 'query',
    key: operation.key,
    method: operation.method === 'POST' ? 'POST' : 'GET',
    path: operation.path,
  }
}

/**
 * Reports a lenient response-validation mismatch recovered by this query's
 * `transform` (the call still succeeded with the raw payload). Isolated: this
 * runs inside `transform`, so an `onError` that throws must not turn a
 * recovered success back into a failure.
 */
function reportRecoveredQueryMismatch(
  onError: ((event: NuxtRpcQueryErrorEvent) => void) | undefined,
  event: NuxtRpcQueryErrorEvent,
): void {
  if (!onError)
    return
  try {
    onError(event)
  }
  catch (hookError) {
    console.error('[nuxt-use-query] an RPC lifecycle hook threw; the call outcome is unaffected:', hookError)
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
  operation: NuxtRpcQueryOperation<NuxtRpcSchema, unknown>,
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
  /** Default response validation mode for every operation called through this client. An operation's own `responseValidation` wins over this. */
  responseValidation?: NuxtRpcResponseValidation
  /**
   * Resolves an `'auto'` `responseValidation` to a concrete mode. Defaults to
   * reading Nuxt's `import.meta.dev` (`true` in a dev build ⇒ `strict`,
   * `false` in production ⇒ `lenient`). Override for tests, or if this
   * client's dev/prod signal isn't `import.meta.dev`.
   */
  isDev?: NuxtRpcClientOptions['isDev']
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
    responseValidation: options.responseValidation,
    isDev: options.isDev,
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
