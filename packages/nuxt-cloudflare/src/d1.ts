export type D1WriteSafety
  = | { _tag: 'lock-only' }
    | { _tag: 'replay-safe' }

export const D1_MAX_BOUND_PARAMETERS = 100

const D1_PARAMETER_PLAN = Symbol('@harlan-zw/nuxt-cloudflare:d1-parameter-plan')

export interface D1ParameterPlanInput {
  parametersPerItem: number
  reservedParameters: number
}

export interface D1ParameterPlan {
  readonly [D1_PARAMETER_PLAN]: true
  readonly itemsPerStatement: number
  readonly parametersPerItem: number
  readonly reservedParameters: number
}

export type D1Consistency
  = | { _tag: 'first-primary' }
    | { _tag: 'first-unconstrained' }
    | { _tag: 'bookmark', bookmark: string }

export interface D1SessionSource<Session> {
  withSession: (constraint: string) => Session
}

export interface RetryIdempotentD1WriteOptions<T> {
  maxAttempts?: number
  random?: () => number
  run: () => Promise<T>
  safety: D1WriteSafety
  sleep?: (milliseconds: number) => Promise<void>
}

export type D1RetryErrorKind
  = | { _tag: 'lock' }
    | { _tag: 'transient' }
    | { _tag: 'permanent' }

const REQUEST_D1_SESSIONS = Symbol.for('@harlan-zw/nuxt-cloudflare:d1-sessions')
const TRANSIENT_D1_SIGNALS = [
  'Network connection lost',
  'operation was aborted',
  'overloaded',
  'Requests queued for too long',
  'exceeded its CPU time limit',
  'storage caused object to be reset',
  'reset because its code was updated',
  'Internal error in D1',
  'cannot resolve d1 db due to transient issue on remote node',
] as const

function consistencyConstraint(consistency: D1Consistency): string {
  if (consistency._tag === 'bookmark')
    return consistency.bookmark
  return consistency._tag
}

function retryDelay(attempt: number, random: () => number): number {
  const exponentialDelay = 60 * 2 ** attempt
  return Math.round(exponentialDelay * (0.5 + random()))
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function parseMaxAttempts(value: number | undefined): number {
  const attempts = value ?? 4
  if (!Number.isSafeInteger(attempts) || attempts < 1)
    throw new TypeError('D1 maxAttempts must be a positive integer')
  return attempts
}

function parseParameterCount(name: string, value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new TypeError(`D1 ${name} must be an integer greater than or equal to ${minimum}`)
  return value
}

export function defineD1ParameterPlan(input: D1ParameterPlanInput): D1ParameterPlan {
  const parametersPerItem = parseParameterCount('parametersPerItem', input.parametersPerItem, 1)
  const reservedParameters = parseParameterCount(
    'reservedParameters',
    input.reservedParameters,
    0,
  )
  const itemsPerStatement = Math.floor(
    (D1_MAX_BOUND_PARAMETERS - reservedParameters) / parametersPerItem,
  )
  if (itemsPerStatement < 1)
    throw new TypeError('D1 parameter budget cannot fit one item')
  return Object.freeze({
    [D1_PARAMETER_PLAN]: true as const,
    itemsPerStatement,
    parametersPerItem,
    reservedParameters,
  })
}

export function chunkD1Items<T>(items: readonly T[], plan: D1ParameterPlan): T[][] {
  if (plan?.[D1_PARAMETER_PLAN] !== true)
    throw new TypeError('D1 parameter plan must come from defineD1ParameterPlan')
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += plan.itemsPerStatement)
    chunks.push(items.slice(index, index + plan.itemsPerStatement))
  return chunks
}

export function assertD1BoundParameters(parameters: readonly unknown[]): void {
  if (!Array.isArray(parameters))
    throw new TypeError('D1 bound parameters must be an array')
  if (parameters.length > D1_MAX_BOUND_PARAMETERS) {
    throw new RangeError(
      `D1 statement has ${parameters.length} bound parameters; maximum is ${D1_MAX_BOUND_PARAMETERS}`,
    )
  }
}

export function classifyD1RetryError(error: unknown): D1RetryErrorKind {
  const messages: string[] = []
  const seen = new WeakSet<object>()
  let current: unknown = error
  while (current !== undefined && current !== null) {
    if (typeof current !== 'object') {
      messages.push(String(current))
      break
    }
    if (seen.has(current))
      break
    seen.add(current)
    if (current instanceof Error)
      messages.push(current.message)
    else if ('message' in current && typeof current.message === 'string')
      messages.push(current.message)
    current = 'cause' in current ? current.cause : undefined
  }
  if (messages.some(message => /busy|locked/i.test(message)))
    return { _tag: 'lock' }
  if (messages.some((message) => {
    const normalized = message.toLowerCase()
    return TRANSIENT_D1_SIGNALS.some(signal => normalized.includes(signal.toLowerCase()))
  })) {
    return { _tag: 'transient' }
  }
  return { _tag: 'permanent' }
}

export function isTransientD1Error(error: unknown): boolean {
  return classifyD1RetryError(error)._tag === 'transient'
}

export function getRequestD1Session<Session>(
  requestContext: Record<PropertyKey, unknown>,
  binding: string,
  database: D1SessionSource<Session>,
  consistency: D1Consistency = { _tag: 'first-primary' },
): Session {
  const existing = requestContext[REQUEST_D1_SESSIONS]
  if (existing !== undefined && !(existing instanceof Map))
    throw new TypeError('Request D1 session cache has an invalid value')
  const sessions = existing ?? new Map<string, unknown>()
  requestContext[REQUEST_D1_SESSIONS] = sessions
  const constraint = consistencyConstraint(consistency)
  const key = `${binding}:${constraint}`
  if (!sessions.has(key))
    sessions.set(key, database.withSession(constraint))
  return sessions.get(key) as Session
}

export async function retryIdempotentD1Write<T>(options: RetryIdempotentD1WriteOptions<T>): Promise<T> {
  const maxAttempts = parseMaxAttempts(options.maxAttempts)
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? defaultSleep
  let lastError: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const outcome = await Promise.resolve().then(options.run).then(
      value => ({ _tag: 'ok' as const, value }),
      error => ({ _tag: 'error' as const, error }),
    )
    if (outcome._tag === 'ok')
      return outcome.value

    lastError = outcome.error
    const kind = classifyD1RetryError(outcome.error)
    const retryable = kind._tag === 'lock'
      || (kind._tag === 'transient' && options.safety._tag === 'replay-safe')
    if (!retryable || attempt + 1 >= maxAttempts)
      throw outcome.error
    await sleep(retryDelay(attempt, random))
  }

  throw lastError
}
