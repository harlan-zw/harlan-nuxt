export type D1WriteSafety
  = | { _tag: 'lock-only' }
    | { _tag: 'replay-safe' }

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

export function classifyD1RetryError(error: unknown): D1RetryErrorKind {
  const message = error instanceof Error ? error.message : String(error)
  if (/busy|locked/i.test(message))
    return { _tag: 'lock' }
  if (TRANSIENT_D1_SIGNALS.some(signal => message.includes(signal)))
    return { _tag: 'transient' }
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
    const outcome = await options.run().then(
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
