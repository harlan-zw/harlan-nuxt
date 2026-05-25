import type { $Fetch } from 'nitropack'
import type { z, ZodIssue } from 'zod'
import { ZodError } from 'zod'

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
  onError?: (event: NuxtRpcErrorEvent) => void | Promise<void>
  onSuccess?: (event: NuxtRpcSuccessEvent) => void | Promise<void>
  onSettled?: (event: NuxtRpcSettledEvent) => void | Promise<void>
}

export interface NuxtRpcCallOptions {
  silent?: boolean
}

export interface NuxtRpcOperationContext {
  kind: 'query' | 'mutation'
  key?: NuxtRpcKey
  method: 'GET' | NuxtRpcBodyMethod | NuxtRpcBodylessMethod
  path: string
}

export interface NuxtRpcValidationIssue {
  code: string
  message: string
  path: string
}

export type NuxtRpcError
  = | {
    type: 'fetch'
    message: string
    status?: number
    statusMessage?: string
    data?: unknown
    response?: unknown
    cause: unknown
  }
  | {
    type: 'request-validation' | 'response-validation'
    message: string
    issues: NuxtRpcValidationIssue[]
    cause: ZodError
  }
  | {
    type: 'unknown'
    message: string
    cause: unknown
  }

export interface NuxtRpcErrorEvent {
  operation: NuxtRpcOperationContext
  error: NuxtRpcError
  durationMs: number
}

export interface NuxtRpcSuccessEvent {
  operation: NuxtRpcOperationContext
  data: unknown
  durationMs: number
}

export interface NuxtRpcSettledEvent {
  operation: NuxtRpcOperationContext
  data?: unknown
  error?: NuxtRpcError
  durationMs: number
}

export function createNuxtRpcClient(options: NuxtRpcClientOptions) {
  const { fetch, onError, onSettled, onSuccess } = options

  async function query<TResponseSchema extends z.ZodTypeAny, TQuery = undefined>(
    operation: NuxtRpcQueryOperation<TResponseSchema, TQuery>,
    callOptions: NuxtRpcCallOptions = {},
  ) {
    const startedAt = Date.now()
    const context: NuxtRpcOperationContext = {
      kind: 'query',
      key: operation.key,
      method: 'GET',
      path: operation.path,
    }
    try {
      const response = await fetch<z.output<TResponseSchema>>(operation.path, {
        ...(operation.query === undefined ? {} : { query: operation.query }),
      } as any)
      const data = parseNuxtRpcResponse(operation.response, response)
      await notifyRpcSuccess({ data, durationMs: Date.now() - startedAt, onSettled, onSuccess, operation: context })
      return data
    }
    catch (error) {
      const normalized = normalizeNuxtRpcError(error, 'response-validation')
      await notifyRpcError({ durationMs: Date.now() - startedAt, error: normalized, onError, onSettled, operation: context, silent: callOptions.silent })
      throw normalized
    }
  }

  async function execute<TBodySchema extends z.ZodTypeAny | null | undefined, TResponseSchema extends z.ZodTypeAny>(
    operation: NuxtRpcMutationOperation<TBodySchema, TResponseSchema>,
    ...args: TBodySchema extends z.ZodTypeAny
      ? [body: z.input<TBodySchema>, options?: NuxtRpcCallOptions]
      : [options?: NuxtRpcCallOptions]
  ) {
    const startedAt = Date.now()
    const context: NuxtRpcOperationContext = {
      kind: 'mutation',
      method: operation.method,
      path: operation.path,
    }
    const body = operation.body ? args[0] : undefined
    const callOptions = (operation.body ? args[1] : args[0]) as NuxtRpcCallOptions | undefined
    try {
      const parsedBody = operation.body ? parseNuxtRpcBody(operation.body, body) : undefined
      const response = await fetch<z.output<TResponseSchema>>(operation.path, {
        method: operation.method,
        ...(operation.body == null ? {} : { body: parsedBody }),
      } as any)
      const data = parseNuxtRpcResponse(operation.response, response)
      await notifyRpcSuccess({ data, durationMs: Date.now() - startedAt, onSettled, onSuccess, operation: context })
      return data
    }
    catch (error) {
      const normalized = normalizeNuxtRpcError(error, 'response-validation')
      await notifyRpcError({ durationMs: Date.now() - startedAt, error: normalized, onError, onSettled, operation: context, silent: callOptions?.silent })
      throw normalized
    }
  }

  return { execute, query }
}

export function formatNuxtRpcValidationIssues(error: ZodError): NuxtRpcValidationIssue[] {
  return error.issues.map(formatNuxtRpcValidationIssue)
}

export function toHumanNuxtRpcError(error: unknown): string {
  const normalized = isNuxtRpcError(error) ? error : normalizeNuxtRpcError(error, 'response-validation')
  if (normalized.type === 'request-validation')
    return firstIssueMessage(normalized.issues) ?? 'Some fields need attention.'
  if (normalized.type === 'response-validation')
    return 'The server returned data in an unexpected format.'
  if (normalized.type === 'fetch') {
    if (normalized.status === 401)
      return 'Please sign in again.'
    if (normalized.status === 403)
      return 'You do not have permission to do that.'
    if (normalized.status === 404)
      return 'We could not find that resource.'
    if (normalized.status != null && normalized.status >= 500)
      return 'The server had a problem. Try again shortly.'
    return normalized.statusMessage || normalized.message || 'The request failed.'
  }
  return normalized.message || 'Something went wrong.'
}

export function normalizeNuxtRpcError(error: unknown, zodType: 'request-validation' | 'response-validation' = 'response-validation'): NuxtRpcError {
  if (isNuxtRpcError(error))
    return error
  if (error instanceof ZodError) {
    return {
      type: zodType,
      message: zodType === 'request-validation'
        ? 'Request validation failed.'
        : 'Response validation failed.',
      issues: formatNuxtRpcValidationIssues(error),
      cause: error,
    }
  }
  const fetchLike = error as {
    message?: string
    data?: unknown
    response?: { status?: number, statusText?: string, _data?: unknown }
    status?: number
    statusCode?: number
    statusMessage?: string
  }
  const status = fetchLike.status ?? fetchLike.statusCode ?? fetchLike.response?.status
  if (status != null || fetchLike.response != null || fetchLike.data !== undefined) {
    return {
      type: 'fetch',
      message: fetchLike.message || fetchLike.statusMessage || 'Request failed.',
      status,
      statusMessage: fetchLike.statusMessage ?? fetchLike.response?.statusText,
      data: fetchLike.data ?? fetchLike.response?._data,
      response: fetchLike.response,
      cause: error,
    }
  }
  return {
    type: 'unknown',
    message: fetchLike.message || 'Unknown RPC error.',
    cause: error,
  }
}

function parseNuxtRpcBody<TBodySchema extends z.ZodTypeAny>(schema: TBodySchema, body: unknown): z.output<TBodySchema> {
  try {
    return schema.parse(body)
  }
  catch (error) {
    throw normalizeNuxtRpcError(error, 'request-validation')
  }
}

function parseNuxtRpcResponse<TResponseSchema extends z.ZodTypeAny>(schema: TResponseSchema, response: unknown): z.output<TResponseSchema> {
  try {
    return schema.parse(response)
  }
  catch (error) {
    throw normalizeNuxtRpcError(error, 'response-validation')
  }
}

function isNuxtRpcError(error: unknown): error is NuxtRpcError {
  return typeof error === 'object'
    && error != null
    && 'type' in error
    && ['fetch', 'request-validation', 'response-validation', 'unknown'].includes((error as { type?: string }).type || '')
}

function formatNuxtRpcValidationIssue(issue: ZodIssue): NuxtRpcValidationIssue {
  return {
    code: issue.code,
    message: issue.message,
    path: issue.path.map(String).join('.'),
  }
}

function firstIssueMessage(issues: NuxtRpcValidationIssue[]): string | undefined {
  const issue = issues[0]
  if (!issue)
    return undefined
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message
}

async function notifyRpcSuccess(options: {
  operation: NuxtRpcOperationContext
  data: unknown
  durationMs: number
  onSuccess?: NuxtRpcClientOptions['onSuccess']
  onSettled?: NuxtRpcClientOptions['onSettled']
}) {
  const event = {
    operation: options.operation,
    data: options.data,
    durationMs: options.durationMs,
  }
  await options.onSuccess?.(event)
  await options.onSettled?.(event)
}

async function notifyRpcError(options: {
  operation: NuxtRpcOperationContext
  error: NuxtRpcError
  durationMs: number
  silent?: boolean
  onError?: NuxtRpcClientOptions['onError']
  onSettled?: NuxtRpcClientOptions['onSettled']
}) {
  const event = {
    operation: options.operation,
    error: options.error,
    durationMs: options.durationMs,
  }
  if (!options.silent)
    await options.onError?.(event)
  await options.onSettled?.(event)
}
