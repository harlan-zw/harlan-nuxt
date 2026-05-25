import type { $Fetch } from 'nitropack'
import type { z } from 'zod'

export type NuxtRpcKey = string | readonly [string, ...unknown[]]

export interface NuxtRpcQueryOperation<TResponseSchema extends z.ZodTypeAny, TQuery = undefined> {
  /** Stable cache key. Keep helpers beside operations for shared invalidation. */
  key: NuxtRpcKey
  /** API endpoint owned by this operation. Consumers should not hardcode it at call sites. */
  path: string
  query?: TQuery
  /** Zod response contract. `useNuxtRpcQuery` parses every payload through this. */
  response: TResponseSchema
}

type NuxtRpcBodyMethod = 'PATCH' | 'POST' | 'PUT'
type NuxtRpcBodylessMethod = 'DELETE'

export interface NuxtRpcBodyMutationOperation<TBodySchema extends z.ZodTypeAny | null, TResponseSchema extends z.ZodTypeAny> {
  /** Optional Zod request body contract. Required for writes with payloads. */
  body: TBodySchema
  method: NuxtRpcBodyMethod
  /** API endpoint owned by this operation. Consumers should not hardcode it at call sites. */
  path: string
  /** Zod response contract. `useNuxtRpc().execute` parses every payload through this. */
  response: TResponseSchema
}

export interface NuxtRpcBodylessMutationOperation<TResponseSchema extends z.ZodTypeAny> {
  body?: undefined
  method: NuxtRpcBodylessMethod
  /** API endpoint owned by this operation. Consumers should not hardcode it at call sites. */
  path: string
  /** Zod response contract. `useNuxtRpc().execute` parses every payload through this. */
  response: TResponseSchema
}

export type NuxtRpcMutationOperation<TBodySchema extends z.ZodTypeAny | null | undefined, TResponseSchema extends z.ZodTypeAny>
  = TBodySchema extends z.ZodTypeAny | null
    ? NuxtRpcBodyMutationOperation<TBodySchema, TResponseSchema>
    : NuxtRpcBodylessMutationOperation<TResponseSchema>

export type NuxtRpcOperationDefinition
  = NuxtRpcQueryOperation<z.ZodTypeAny, any>
    | NuxtRpcMutationOperation<z.ZodTypeAny | null | undefined, z.ZodTypeAny>
    | ((...args: any[]) => NuxtRpcQueryOperation<z.ZodTypeAny, any> | NuxtRpcMutationOperation<z.ZodTypeAny | null | undefined, z.ZodTypeAny>)

export function serializeNuxtRpcKey(key: NuxtRpcKey): string {
  return typeof key === 'string'
    ? key
    : key.map(part => encodeURIComponent(String(part))).join(':')
}

export function defineNuxtQueryGroup<TGroup extends Record<string, NuxtRpcOperationDefinition>>(_namespace: string, group: TGroup): TGroup {
  return group
}

export function defineNuxtRpcQuery<TResponseSchema extends z.ZodTypeAny, TQuery = undefined>(
  operation: NuxtRpcQueryOperation<TResponseSchema, TQuery>,
) {
  return operation
}

export function defineNuxtRpcMutation<TBodySchema extends z.ZodTypeAny | null, TResponseSchema extends z.ZodTypeAny>(
  operation: NuxtRpcBodyMutationOperation<TBodySchema, TResponseSchema>,
): NuxtRpcBodyMutationOperation<TBodySchema, TResponseSchema>
export function defineNuxtRpcMutation<TResponseSchema extends z.ZodTypeAny>(
  operation: NuxtRpcBodylessMutationOperation<TResponseSchema>,
): NuxtRpcBodylessMutationOperation<TResponseSchema>
export function defineNuxtRpcMutation<TBodySchema extends z.ZodTypeAny | null | undefined, TResponseSchema extends z.ZodTypeAny>(
  operation: NuxtRpcMutationOperation<TBodySchema, TResponseSchema>,
) {
  return operation
}

export interface NuxtRpcClientOptions {
  fetch: $Fetch
}

export function createNuxtRpcClient(options: NuxtRpcClientOptions) {
  const { fetch } = options

  async function query<TResponseSchema extends z.ZodTypeAny, TQuery = undefined>(
    operation: NuxtRpcQueryOperation<TResponseSchema, TQuery>,
  ) {
    const response = await fetch<z.output<TResponseSchema>>(operation.path, {
      ...(operation.query === undefined ? {} : { query: operation.query }),
    } as any)
    return operation.response.parse(response)
  }

  async function execute<TBodySchema extends z.ZodTypeAny | null | undefined, TResponseSchema extends z.ZodTypeAny>(
    operation: NuxtRpcMutationOperation<TBodySchema, TResponseSchema>,
    ...args: TBodySchema extends z.ZodTypeAny ? [body: z.input<TBodySchema>] : []
  ) {
    const body = args[0]
    const parsedBody = operation.body ? operation.body.parse(body) : undefined
    const response = await fetch<z.output<TResponseSchema>>(operation.path, {
      method: operation.method,
      ...(operation.body == null ? {} : { body: parsedBody }),
    } as any)
    return operation.response.parse(response)
  }

  return { execute, query }
}
