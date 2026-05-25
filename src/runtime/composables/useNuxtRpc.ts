import type { MaybeRefOrGetter } from 'vue'
import type { z } from 'zod'
import type { NuxtRpcClientOptions, NuxtRpcQueryOperation } from '../rpc/core'
import type { UseNuxtQueryOptions } from './useNuxtQuery'
import { computed, toValue } from 'vue'
import { useNuxtApp } from '#app'
import { createNuxtRpcClient, serializeNuxtRpcKey } from '../rpc/core'
import { useNuxtQuery } from './useNuxtQuery'

export {
  createNuxtRpcClient,
  defineNuxtQueryGroup,
  defineNuxtRpcMutation,
  defineNuxtRpcQuery,
  serializeNuxtRpcKey,
} from '../rpc/core'
export type {
  NuxtRpcBodylessMutationOperation,
  NuxtRpcBodyMutationOperation,
  NuxtRpcClientOptions,
  NuxtRpcKey,
  NuxtRpcMutationOperation,
  NuxtRpcOperationDefinition,
  NuxtRpcQueryOperation,
} from '../rpc/core'

export function useNuxtRpcQuery<TResponseSchema extends z.ZodTypeAny, TQuery = undefined>(
  operation: MaybeRefOrGetter<NuxtRpcQueryOperation<TResponseSchema, TQuery>>,
  options: Omit<UseNuxtQueryOptions<z.output<TResponseSchema>>, 'key' | 'query'> = {},
) {
  const resolved = () => toValue(operation)
  return useNuxtQuery<z.output<TResponseSchema>>(() => resolved().path, {
    ...options,
    key: () => serializeNuxtRpcKey(resolved().key),
    query: computed(() => resolved().query),
    transform: (payload: unknown) => resolved().response.parse(payload),
  })
}

export interface UseNuxtRpcOptions {
  fetch?: NuxtRpcClientOptions['fetch']
}

// eslint-disable-next-line harlanzw/vue-no-faux-composables -- wraps Nuxt app fetch in an RPC executor factory.
export function useNuxtRpc(options: UseNuxtRpcOptions = {}) {
  return createNuxtRpcClient({
    fetch: options.fetch ?? (useNuxtApp().$fetch as NuxtRpcClientOptions['fetch']),
  })
}
