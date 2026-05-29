import type { MaybeRefOrGetter } from 'vue'
import type { z } from 'zod'
import type {
  NuxtRpcClientOptions,
  NuxtRpcQueryOperation,
} from '../rpc/core'
import type { KeysOf, UseNuxtQueryOptions } from './useNuxtQuery'
import { computed, toValue } from 'vue'
import { useNuxtApp } from '#app'
import {
  createNuxtRpcClient,
  normalizeNuxtRpcError,
  serializeNuxtRpcKey,
} from '../rpc/core'
import { useNuxtQuery } from './useNuxtQuery'

// `DefaultT` must stay a generic so the `default` factory drives its own
// inference. Without it `DefaultT` pins to `undefined` and `default` collapses
// to `() => Ref<undefined, undefined> | undefined`, rejecting every real value.
export type UseNuxtRpcQueryOptions<TData, DefaultT = undefined> = Omit<
  UseNuxtQueryOptions<TData, TData, KeysOf<TData>, DefaultT>,
  'key' | 'query' | 'transform'
>

export function useNuxtRpcQuery<
  TResponseSchema extends z.ZodTypeAny,
  TQuery = undefined,
  DefaultT = undefined,
>(
  operation: MaybeRefOrGetter<NuxtRpcQueryOperation<TResponseSchema, TQuery>>,
  options: UseNuxtRpcQueryOptions<z.output<TResponseSchema>, DefaultT> = {},
) {
  const resolved = () => toValue(operation)
  return (useNuxtQuery as any)(() => resolved().path, {
    ...options,
    key: () => serializeNuxtRpcKey(resolved().key),
    query: computed(() => resolved().query),
    transform: (payload: unknown) => {
      try {
        return resolved().response.parse(payload)
      }
      catch (error) {
        throw normalizeNuxtRpcError(error, 'response-validation')
      }
    },
  } as UseNuxtQueryOptions<z.output<TResponseSchema>>)
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
    fetch: options.fetch ?? (nuxtApp.$fetch as NuxtRpcClientOptions['fetch']),
    onError: withContext(options.onError),
    onSettled: withContext(options.onSettled),
    onSuccess: withContext(options.onSuccess),
  })
}
