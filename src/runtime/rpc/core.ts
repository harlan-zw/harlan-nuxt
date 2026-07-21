import type { $Fetch } from 'nitropack'
import type { z, ZodIssue } from 'zod'
import type { Outcome } from '../lifecycle'
import { ZodError } from 'zod'
import { runIsolatedHooks, toOutcome } from '../lifecycle'

export type NuxtRpcKey = string | readonly [string, ...unknown[]]

export interface NuxtRpcGetQueryOperation<TResponseSchema extends z.ZodTypeAny, TQuery = undefined> {
  /** Stable cache key. Keep helpers beside operations for shared invalidation. */
  key: NuxtRpcKey
  /** GET remains the default for existing query definitions. */
  method?: 'GET'
  /** API endpoint owned by this operation. Consumers should not hardcode it at call sites. */
  path: string
  query?: TQuery
  body?: never
  /** Zod response contract. `useNuxtRpcQuery` parses every payload through this. */
  response: TResponseSchema
}

export interface NuxtRpcQueryBody<TBodySchema extends z.ZodTypeAny> {
  /** Parse at the request boundary before either keying or sending the body. */
  schema: TBodySchema
  /** Raw caller input; the parsed output is sent and included in the cache key. */
  value: z.input<TBodySchema>
}

export interface NuxtRpcPostQueryOperation<
  TResponseSchema extends z.ZodTypeAny,
  TQuery = undefined,
  TBodySchema extends z.ZodTypeAny = z.ZodTypeAny,
> {
  /** A POST can still be a cacheable read when selected by the query factory. */
  key: NuxtRpcKey
  method: 'POST'
  /** Required safety assertion for a cached POST read; mutations use their own factory. */
  idempotent: true
  path: string
  query?: TQuery
  body: NuxtRpcQueryBody<TBodySchema>
  response: TResponseSchema
}

/**
 * Query operation union. The body-schema generic is intentionally last so
 * existing `NuxtRpcQueryOperation<Response, Query>` annotations keep their
 * meaning while also accepting generated cached-POST operations.
 */
export type NuxtRpcQueryOperation<
  TResponseSchema extends z.ZodTypeAny,
  TQuery = undefined,
  TBodySchema extends z.ZodTypeAny = z.ZodTypeAny,
> = NuxtRpcGetQueryOperation<TResponseSchema, TQuery>
  | NuxtRpcPostQueryOperation<TResponseSchema, TQuery, TBodySchema>

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
    : key.map(part => encodeURIComponent(serializeNuxtRpcKeyPart(part))).join(':')
}

function serializeNuxtRpcKeyPart(part: unknown): string {
  if (typeof part === 'string')
    return part.startsWith('$') ? `$string:${part}` : part
  if (typeof part === 'number')
    return `$number:${String(part)}`
  if (typeof part === 'bigint')
    return `$bigint:${String(part)}`
  if (typeof part === 'boolean')
    return `$boolean:${part ? 'true' : 'false'}`
  if (part === null)
    return '$null'
  if (part === undefined)
    return '$undefined'
  if (typeof part === 'object')
    return `$json:${serializeCanonicalJson(part)}`
  throw new TypeError('RPC query keys cannot contain functions or symbols.')
}

const RPC_BODY_KEY_SEGMENT = '$body'
const RPC_INVALID_BODY_KEY_SEGMENT = '$invalid-body'

export interface ResolvedNuxtRpcQueryRequest {
  body?: unknown
  key: string
  method: 'GET' | 'POST'
  path: string
  query?: unknown
}

/**
 * Validate and resolve a query request exactly once. Cached POST bodies use the
 * parsed Zod output both on the wire and in a deterministic key suffix, so two
 * semantically identical objects cannot diverge because of insertion order.
 */
export function resolveNuxtRpcQueryRequest(
  operation: NuxtRpcQueryOperation<z.ZodTypeAny, unknown, z.ZodTypeAny>,
): ResolvedNuxtRpcQueryRequest {
  const base = serializeNuxtRpcKey(operation.key)
  if (operation.method !== 'POST') {
    return {
      key: base,
      method: 'GET',
      path: operation.path,
      query: operation.query,
    }
  }

  const body = parseNuxtRpcBody(operation.body.schema, operation.body.value)
  const canonicalBody = serializeCanonicalJson(body)
  return {
    body,
    key: `${base}:${encodeURIComponent(RPC_BODY_KEY_SEGMENT)}:${encodeURIComponent(canonicalBody)}`,
    method: 'POST',
    path: operation.path,
    query: operation.query,
  }
}

/** Exact key used by `useNuxtRpcQuery`, including a cached POST's body suffix. */
export function serializeNuxtRpcQueryKey(
  operation: NuxtRpcQueryOperation<z.ZodTypeAny, unknown, z.ZodTypeAny>,
): string {
  return resolveNuxtRpcQueryRequest(operation).key
}

/** Stable fallback key used only to park a declarative request-validation error. */
export function serializeInvalidNuxtRpcQueryKey(operation: { key: NuxtRpcKey }, error: NuxtRpcError): string {
  const issueSignature = error.type === 'request-validation'
    ? JSON.stringify(error.issues)
    : error.type
  return `${serializeNuxtRpcKey(operation.key)}:${encodeURIComponent(RPC_INVALID_BODY_KEY_SEGMENT)}:${encodeURIComponent(issueSignature)}`
}

/**
 * Canonical JSON serialization for cache identity. It intentionally accepts
 * only wire-safe JSON values. Optional object properties with `undefined` are
 * omitted just like JSON.stringify; unsupported array/root values fail closed.
 */
export function serializeCanonicalJson(value: unknown): string {
  const ancestors = new Set<object>()

  function visit(input: unknown, inObjectProperty = false): string | undefined {
    if (input === null)
      return 'null'
    if (typeof input === 'string' || typeof input === 'boolean')
      return JSON.stringify(input)
    if (typeof input === 'number') {
      if (!Number.isFinite(input))
        throw new TypeError('Cached query bodies must contain only finite numbers.')
      return JSON.stringify(input)
    }
    if (input === undefined && inObjectProperty)
      return undefined
    if (input === undefined || typeof input === 'bigint' || typeof input === 'function' || typeof input === 'symbol')
      throw new TypeError('Cached query bodies must be JSON-serializable.')
    if (typeof input !== 'object')
      throw new TypeError('Cached query bodies must be JSON-serializable.')
    if (ancestors.has(input))
      throw new TypeError('Cached query bodies cannot contain circular references.')

    ancestors.add(input)
    try {
      if (Array.isArray(input)) {
        if (typeof (input as { toJSON?: unknown }).toJSON === 'function')
          throw new TypeError('Cached query body arrays cannot define toJSON().')
        const items: string[] = []
        for (let index = 0; index < input.length; index++) {
          // JSON.stringify turns a sparse slot into `null`. Silently skipping
          // it would make `[,,]` alias `[]` in the cache while sending a
          // different body on the wire, so sparse arrays fail closed just like
          // explicit `undefined` array members.
          if (!Object.hasOwn(input, index))
            throw new TypeError('Cached query body arrays cannot be sparse.')
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index))!
          if (!('value' in descriptor))
            throw new TypeError('Cached query body arrays cannot contain accessors.')
          const serialized = visit(descriptor.value)
          if (serialized === undefined)
            throw new TypeError('Cached query body arrays cannot contain undefined values.')
          items.push(serialized)
        }
        return `[${items.join(',')}]`
      }

      const prototype = Object.getPrototypeOf(input)
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError('Cached query bodies must contain only plain JSON objects.')
      const entries: string[] = []
      for (const key of Object.keys(input as Record<string, unknown>).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!
        if (!('value' in descriptor))
          throw new TypeError('Cached query body objects cannot contain accessors.')
        const serialized = visit(descriptor.value, true)
        if (serialized !== undefined)
          entries.push(`${JSON.stringify(key)}:${serialized}`)
      }
      return `{${entries.join(',')}}`
    }
    finally {
      ancestors.delete(input)
    }
  }

  const serialized = visit(value)
  if (serialized === undefined)
    throw new TypeError('Cached query bodies must be JSON-serializable.')
  return serialized
}

export function defineNuxtQueryGroup<TGroup extends Record<string, NuxtRpcOperationDefinition>>(_namespace: string, group: TGroup): TGroup {
  return group
}

export function defineNuxtRpcQuery<TResponseSchema extends z.ZodTypeAny, TQuery = undefined>(
  operation: NuxtRpcGetQueryOperation<TResponseSchema, TQuery>,
): NuxtRpcGetQueryOperation<TResponseSchema, TQuery>
export function defineNuxtRpcQuery<
  TResponseSchema extends z.ZodTypeAny,
  TQuery = undefined,
  TBodySchema extends z.ZodTypeAny = z.ZodTypeAny,
>(
  operation: NuxtRpcPostQueryOperation<TResponseSchema, TQuery, TBodySchema>,
): NuxtRpcPostQueryOperation<TResponseSchema, TQuery, TBodySchema>
export function defineNuxtRpcQuery<
  TResponseSchema extends z.ZodTypeAny,
  TQuery = undefined,
  TBodySchema extends z.ZodTypeAny = z.ZodTypeAny,
>(
  operation: NuxtRpcQueryOperation<TResponseSchema, TQuery, TBodySchema>,
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
    // Transient transport failures with no HTTP response — all retryable
    // except `aborted` (a deliberate cancellation, usually safe to ignore).
    // Split out of `unknown` so callers can react without string-matching.
    type: 'timeout' | 'connection' | 'aborted'
    message: string
    cause: unknown
  }
  | {
    type: 'unknown'
    message: string
    cause: unknown
  }

/**
 * Tagged outcome of an RPC call. The `*Safe` client methods return this
 * instead of throwing, so an expected RPC failure shows up as a value with a
 * fully-typed `NuxtRpcError` (discriminate on `error.type`) rather than a
 * thrown `unknown`. Discriminate on `_tag`.
 */
export type NuxtRpcResult<TData>
  = Outcome<TData, NuxtRpcError>

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

  // Single place the success/error hooks fire and the timing is measured.
  // `perform` does the fetch+parse; everything that can throw a domain error
  // (body validation, network, response validation) runs inside it and is
  // normalized to a tagged value. The outcome is decided BEFORE any hook fires,
  // so a throwing `onSuccess` can't flip a success to an error. Hooks then run
  // in isolation (see `notifyRpc*`), so `run` itself never throws — that's what
  // lets `querySafe`/`executeSafe` honour their no-throw contract regardless of
  // caller-supplied callbacks. The throwing `query`/`execute` wrappers re-throw
  // the Err themselves for TanStack parity.
  async function run<TData>(
    context: NuxtRpcOperationContext,
    silent: boolean | undefined,
    perform: () => Promise<TData>,
  ): Promise<NuxtRpcResult<TData>> {
    const startedAt = Date.now()
    const outcome = await toOutcome(
      perform,
      error => normalizeNuxtRpcError(error, 'response-validation'),
    )
    const durationMs = Date.now() - startedAt
    if (outcome._tag === 'ok')
      await notifyRpcSuccess({ data: outcome.data, durationMs, onSettled, onSuccess, operation: context })
    else
      await notifyRpcError({ durationMs, error: outcome.error, onError, onSettled, operation: context, silent })
    return outcome
  }

  function querySafe<TResponseSchema extends z.ZodTypeAny, TQuery = undefined>(
    operation: NuxtRpcQueryOperation<TResponseSchema, TQuery>,
    callOptions: NuxtRpcCallOptions = {},
  ): Promise<NuxtRpcResult<z.output<TResponseSchema>>> {
    const method = operation.method === 'POST' ? 'POST' : 'GET'
    const context: NuxtRpcOperationContext = {
      kind: 'query',
      key: operation.key,
      method,
      path: operation.path,
    }
    return run(context, callOptions.silent, async () => {
      const request = resolveNuxtRpcQueryRequest(operation)
      const response = await fetch<z.output<TResponseSchema>>(request.path, {
        ...(request.method === 'GET' ? {} : { method: request.method }),
        ...(request.query === undefined ? {} : { query: request.query }),
        ...(request.body === undefined ? {} : { body: request.body }),
      } as any)
      return parseNuxtRpcResponse(operation.response, response)
    })
  }

  function executeSafe<TBodySchema extends z.ZodTypeAny | null | undefined, TResponseSchema extends z.ZodTypeAny>(
    operation: NuxtRpcMutationOperation<TBodySchema, TResponseSchema>,
    ...args: TBodySchema extends z.ZodTypeAny
      ? [body: z.input<TBodySchema>, options?: NuxtRpcCallOptions]
      : [options?: NuxtRpcCallOptions]
  ): Promise<NuxtRpcResult<z.output<TResponseSchema>>> {
    const context: NuxtRpcOperationContext = {
      kind: 'mutation',
      method: operation.method,
      path: operation.path,
    }
    const body = operation.body ? args[0] : undefined
    const callOptions = (operation.body ? args[1] : args[0]) as NuxtRpcCallOptions | undefined
    return run(context, callOptions?.silent, async () => {
      const parsedBody = operation.body ? parseNuxtRpcBody(operation.body, body) : undefined
      const response = await fetch<z.output<TResponseSchema>>(operation.path, {
        method: operation.method,
        ...(operation.body == null ? {} : { body: parsedBody }),
      } as any)
      return parseNuxtRpcResponse(operation.response, response)
    })
  }

  async function query<TResponseSchema extends z.ZodTypeAny, TQuery = undefined>(
    operation: NuxtRpcQueryOperation<TResponseSchema, TQuery>,
    callOptions: NuxtRpcCallOptions = {},
  ): Promise<z.output<TResponseSchema>> {
    const result = await querySafe(operation, callOptions)
    if (result._tag === 'err')
      throw result.error
    return result.data
  }

  async function execute<TBodySchema extends z.ZodTypeAny | null | undefined, TResponseSchema extends z.ZodTypeAny>(
    operation: NuxtRpcMutationOperation<TBodySchema, TResponseSchema>,
    ...args: TBodySchema extends z.ZodTypeAny
      ? [body: z.input<TBodySchema>, options?: NuxtRpcCallOptions]
      : [options?: NuxtRpcCallOptions]
  ): Promise<z.output<TResponseSchema>> {
    const result = await executeSafe(operation, ...args)
    if (result._tag === 'err')
      throw result.error
    return result.data
  }

  return { execute, executeSafe, query, querySafe }
}

function formatNuxtRpcValidationIssues(error: ZodError): NuxtRpcValidationIssue[] {
  return error.issues.map(formatNuxtRpcValidationIssue)
}

export function toHumanNuxtRpcError(error: unknown): string {
  const normalized = isNuxtRpcError(error) ? error : normalizeNuxtRpcError(error, 'response-validation')
  if (normalized.type === 'request-validation')
    return firstIssueMessage(normalized.issues) ?? 'Some fields need attention.'
  if (normalized.type === 'response-validation')
    return 'The server returned data in an unexpected format.'
  if (normalized.type === 'timeout')
    return 'The request took too long. Try again.'
  if (normalized.type === 'connection')
    return 'Can\'t reach the server. Check your connection and try again.'
  if (normalized.type === 'aborted')
    return 'The request was cancelled.'
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

/**
 * Coarse semantic axis over the failure modes — a projection of the precise
 * tag/status, not a new fact. Use it when a call site reacts the same way to a
 * whole class of failures (e.g. all `transient` → retry banner).
 */
export type NuxtRpcErrorCategory = 'transient' | 'auth' | 'validation' | 'client' | 'server' | 'unknown'

export function rpcErrorCategory(error: NuxtRpcError): NuxtRpcErrorCategory {
  switch (error.type) {
    case 'timeout':
    case 'connection':
    case 'aborted':
      return 'transient'
    case 'request-validation':
    case 'response-validation':
      return 'validation'
    case 'unknown':
      return 'unknown'
    case 'fetch':
      if (error.status === 401 || error.status === 403)
        return 'auth'
      if (error.status != null && error.status >= 500)
        return 'server'
      return 'client'
  }
}

/**
 * True when retrying the same call could plausibly succeed: transient transport
 * failures (except a deliberate `aborted`) and server-side `5xx` / `429`.
 * Client `4xx` and validation failures are terminal — retrying won't help.
 */
export function isRetryableRpcError(error: NuxtRpcError): boolean {
  if (error.type === 'timeout' || error.type === 'connection')
    return true
  if (error.type === 'fetch')
    return error.status === 429 || (error.status != null && error.status >= 500)
  return false
}

/** True for an authentication/authorization failure (HTTP `401` / `403`). */
export function isAuthRpcError(error: NuxtRpcError): boolean {
  return error.type === 'fetch' && (error.status === 401 || error.status === 403)
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
  // Transient transport failures arrive with no HTTP response. Classify them
  // before the `fetch` branch (which needs a status/response) so they don't
  // fall through to `unknown`. Checked status-first so a real HTTP error is
  // never misread as a network failure.
  if (status == null && fetchLike.response == null) {
    const transient = detectTransientErrorType(error)
    if (transient != null) {
      return {
        type: transient,
        message: fetchLike.message || transient,
        cause: error,
      }
    }
  }
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

// Classifies a responseless thrown error into a transient transport tag.
// Grounded in ofetch 1.5.1: a `timeout` aborts the signal with an Error whose
// `name === 'TimeoutError'` (surfaced as the FetchError's `cause`); a caller
// abort surfaces as `AbortError`; an unreachable host surfaces as a `TypeError`
// ("Failed to fetch" / undici "fetch failed" with a `cause.code` like
// `ECONNREFUSED`). Returns undefined when the error isn't a known transient.
function detectTransientErrorType(error: unknown): 'timeout' | 'connection' | 'aborted' | undefined {
  const e = error as {
    name?: string
    code?: unknown
    message?: string
    cause?: { name?: string, code?: unknown }
  }
  const names = [e?.name, e?.cause?.name]
  if (names.includes('TimeoutError') || e?.code === 23 || e?.cause?.code === 23)
    return 'timeout'
  if (names.includes('AbortError'))
    return 'aborted'
  const code = String(e?.cause?.code ?? e?.code ?? '').toUpperCase()
  if (['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code))
    return 'connection'
  const message = (e?.message ?? '').toLowerCase()
  if (message.includes('failed to fetch') || message.includes('fetch failed') || message.includes('network request failed'))
    return 'connection'
  return undefined
}

function parseNuxtRpcBody<TBodySchema extends z.ZodTypeAny>(schema: TBodySchema, body: unknown): z.output<TBodySchema> {
  try {
    return schema.parse(body)
  }
  catch (error) {
    throw normalizeNuxtRpcError(error, 'request-validation')
  }
}

export function parseNuxtRpcResponse<TResponseSchema extends z.ZodTypeAny>(schema: TResponseSchema, response: unknown): z.output<TResponseSchema> {
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
    && ['fetch', 'request-validation', 'response-validation', 'timeout', 'connection', 'aborted', 'unknown'].includes((error as { type?: string }).type || '')
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
  await runIsolatedHooks([
    () => options.onSuccess?.(event),
    () => options.onSettled?.(event),
  ], '[nuxt-use-query] an RPC lifecycle hook threw; the call outcome is unaffected:')
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
  await runIsolatedHooks([
    ...(options.silent ? [] : [() => options.onError?.(event)]),
    () => options.onSettled?.(event),
  ], '[nuxt-use-query] an RPC lifecycle hook threw; the call outcome is unaffected:')
}
