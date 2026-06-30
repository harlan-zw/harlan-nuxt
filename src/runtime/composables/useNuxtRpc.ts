import type { MaybeRefOrGetter } from 'vue'
import type { z } from 'zod'
import type {
  NuxtRpcClientOptions,
  NuxtRpcError,
  NuxtRpcKey,
  NuxtRpcQueryOperation,
} from '../rpc/core'
import type { KeysOf, NuxtQuery, UseNuxtQueryOptions } from './useNuxtQuery'
import { computed, toValue } from 'vue'
import { useNuxtApp, useRequestFetch } from '#app'
import {
  createNuxtRpcClient,
  normalizeNuxtRpcError,
  parseNuxtRpcResponse,
  serializeNuxtRpcKey,
} from '../rpc/core'
import { useNuxtQuery } from './useNuxtQuery'
import { invalidateNuxtQueries } from './useQueryCache'

/**
 * Invalidate cached queries for an RPC operation (or a raw key) by its serialized
 * cache key. The type-safe alternative to hand-writing the prefix string, which
 * otherwise has to mirror `serializeNuxtRpcKey` exactly (including its per-segment
 * `encodeURIComponent`). Prefix-matches, so it also catches keys nested under it.
 */

export function invalidateNuxtRpc(operationOrKey: NuxtRpcKey | { key: NuxtRpcKey }): void {
  const isOperation = typeof operationOrKey === 'object' && operationOrKey !== null && 'key' in operationOrKey
  const key = isOperation ? operationOrKey.key : operationOrKey
  invalidateNuxtQueries(serializeNuxtRpcKey(key))
}

// `DefaultT` must stay a generic so the `default` factory drives its own
// inference. Without it `DefaultT` pins to `undefined` and `default` collapses
// to `() => Ref<undefined, undefined> | undefined`, rejecting every real value.
export type UseNuxtRpcQueryOptions<TData, DefaultT = undefined> = Omit<
  UseNuxtQueryOptions<TData, TData, KeysOf<TData>, DefaultT>,
  'key' | 'query' | 'transform'
>

// eslint-disable-next-line harlanzw/vue-no-faux-composables -- Nuxt composable, wraps useNuxtQuery and normalizes its error ref.
export function useNuxtRpcQuery<
  TResponseSchema extends z.ZodTypeAny,
  TQuery = undefined,
  DefaultT = undefined,
>(
  operation: MaybeRefOrGetter<NuxtRpcQueryOperation<TResponseSchema, TQuery>>,
  options: UseNuxtRpcQueryOptions<z.output<TResponseSchema>, DefaultT> = {},
) {
  const resolved = () => toValue(operation)
  const query = (useNuxtQuery as any)(() => resolved().path, {
    ...options,
    key: () => serializeNuxtRpcKey(resolved().key),
    query: computed(() => resolved().query),
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
  query.error = computed({
    get: () => (rawError.value == null ? undefined : normalizeNuxtRpcError(rawError.value)),
    set: value => void (rawError.value = value),
  }) as typeof query.error
  return query
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
