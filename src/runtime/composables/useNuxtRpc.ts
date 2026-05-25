import type { MaybeRefOrGetter } from 'vue'
import type { z } from 'zod'
import type {
  NuxtRpcCallOptions,
  NuxtRpcClientOptions,
  NuxtRpcErrorEvent,
  NuxtRpcQueryOperation,
  NuxtRpcSettledEvent,
  NuxtRpcSuccessEvent,
} from '../rpc/core'
import type { UseNuxtQueryOptions } from './useNuxtQuery'
import { computed, toValue, watch } from 'vue'
import { useNuxtApp } from '#app'
import {
  createNuxtRpcClient,
  normalizeNuxtRpcError,
  serializeNuxtRpcKey,
} from '../rpc/core'
import { useNuxtQuery } from './useNuxtQuery'

export {
  createNuxtRpcClient,
  defineNuxtQueryGroup,
  defineNuxtRpcMutation,
  defineNuxtRpcQuery,
  formatNuxtRpcValidationIssues,
  normalizeNuxtRpcError,
  serializeNuxtRpcKey,
  toHumanNuxtRpcError,
} from '../rpc/core'
export type {
  NuxtRpcBodylessMutationOperation,
  NuxtRpcBodyMutationOperation,
  NuxtRpcCallOptions,
  NuxtRpcClientOptions,
  NuxtRpcError,
  NuxtRpcErrorEvent,
  NuxtRpcKey,
  NuxtRpcMutationOperation,
  NuxtRpcOperationContext,
  NuxtRpcOperationDefinition,
  NuxtRpcQueryOperation,
  NuxtRpcSettledEvent,
  NuxtRpcSuccessEvent,
  NuxtRpcValidationIssue,
} from '../rpc/core'

export interface UseNuxtRpcQueryOptions<TData>
  extends Omit<UseNuxtQueryOptions<TData>, 'key' | 'query' | 'transform'>, NuxtRpcCallOptions {
  onError?: (event: NuxtRpcErrorEvent) => void | Promise<void>
  onSuccess?: (event: NuxtRpcSuccessEvent) => void | Promise<void>
  onSettled?: (event: NuxtRpcSettledEvent) => void | Promise<void>
}

export function useNuxtRpcQuery<TResponseSchema extends z.ZodTypeAny, TQuery = undefined>(
  operation: MaybeRefOrGetter<NuxtRpcQueryOperation<TResponseSchema, TQuery>>,
  options: UseNuxtRpcQueryOptions<z.output<TResponseSchema>> = {},
) {
  const resolved = () => toValue(operation)
  const {
    onError,
    onSettled,
    onSuccess,
    silent,
    ...queryOptions
  } = options
  const query = (useNuxtQuery as any)(() => resolved().path, {
    ...queryOptions,
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
  if (query.error) {
    watch(query.error, async (error) => {
      if (!error)
        return
      const rpcError = normalizeNuxtRpcError(error, 'response-validation')
      const event = {
        operation: {
          kind: 'query' as const,
          key: resolved().key,
          method: 'GET' as const,
          path: resolved().path,
        },
        error: rpcError,
        durationMs: 0,
      }
      if (!silent)
        await onError?.(event)
      await onSettled?.(event)
    })
  }
  if (query.data) {
    watch(query.data, async (data) => {
      if (data == null)
        return
      const event = {
        operation: {
          kind: 'query' as const,
          key: resolved().key,
          method: 'GET' as const,
          path: resolved().path,
        },
        data,
        durationMs: 0,
      }
      await onSuccess?.(event)
      await onSettled?.(event)
    }, { immediate: true })
  }
  return query
}

export interface UseNuxtRpcOptions {
  fetch?: NuxtRpcClientOptions['fetch']
  onError?: NuxtRpcClientOptions['onError']
  onSuccess?: NuxtRpcClientOptions['onSuccess']
  onSettled?: NuxtRpcClientOptions['onSettled']
}

// eslint-disable-next-line harlanzw/vue-no-faux-composables -- wraps Nuxt app fetch in an RPC executor factory.
export function useNuxtRpc(options: UseNuxtRpcOptions = {}) {
  return createNuxtRpcClient({
    fetch: options.fetch ?? (useNuxtApp().$fetch as NuxtRpcClientOptions['fetch']),
    onError: options.onError,
    onSettled: options.onSettled,
    onSuccess: options.onSuccess,
  })
}
