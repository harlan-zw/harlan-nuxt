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

export interface D1StatementLike {
  bind: (...values: never[]) => D1StatementLike
  first: (...args: never[]) => unknown
  run: (...args: never[]) => unknown
  all: (...args: never[]) => unknown
  raw: (...args: never[]) => unknown
}

export interface D1SessionLike {
  prepare: (sql: string) => D1StatementLike
  batch: (statements: never[]) => unknown
  getBookmark: () => string | null
}

export interface RetryIdempotentD1WriteOptions<T> {
  maxAttempts?: number
  random?: () => number
  run: () => Promise<T>
  safety: D1WriteSafety
  sleep?: (milliseconds: number) => Promise<void>
}

export type D1RetryErrorKind
  = | { _tag: 'session-reset' }
    | { _tag: 'lock' }
    | { _tag: 'transient' }
    | { _tag: 'permanent' }

export type D1RecoveryEvent
  = | {
    _tag: 'retrying'
    attempt: number
    failure: { _tag: 'session-reset' } | { _tag: 'transient' }
    sql: string
  }
  | {
    _tag: 'stopped'
    attempt: number
    failure: { _tag: 'session-reset' } | { _tag: 'transient' }
    reason: 'attempts-exhausted' | 'unsafe-statement'
    sql: string
  }

export interface D1ResetRecoveryOptions {
  consistency?: D1Consistency
  maxAttempts?: number
  onRecovery?: (event: D1RecoveryEvent) => void
  random?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

const REQUEST_D1_SESSIONS = Symbol.for('@harlan-zw/nuxt-cloudflare:d1-sessions')
const REQUEST_D1_RECOVERING_SESSIONS = Symbol.for('@harlan-zw/nuxt-cloudflare:d1-recovering-sessions')
const SESSION_RESET_D1_SIGNALS = [
  'D1_RESET_DO',
  'D1 DB reset because its code was updated',
  'Internal error while starting up D1 DB storage caused object to be reset',
  'Internal error in D1 DB storage caused object to be reset',
  'storage caused object to be reset',
] as const
const TRANSIENT_D1_SIGNALS = [
  'Network connection lost',
  'cannot resolve d1 db due to transient issue on remote node',
  'Replica disconnected from primary',
] as const
const D1_STATEMENT_RESOLVER = Symbol('@harlan-zw/nuxt-cloudflare:d1-statement-resolver')
const D1_STATEMENT_SQL = Symbol('@harlan-zw/nuxt-cloudflare:d1-statement-sql')
const D1_TERMINAL_METHODS = new Set(['first', 'run', 'all', 'raw'])

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

function getD1SessionCache(
  requestContext: Record<PropertyKey, unknown>,
  cacheKey: symbol,
): Map<string, unknown> {
  const existing = requestContext[cacheKey]
  if (existing !== undefined && !(existing instanceof Map))
    throw new TypeError('Request D1 session cache has an invalid value')
  const sessions = existing ?? new Map<string, unknown>()
  requestContext[cacheKey] = sessions
  return sessions
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
  if (messages.some((message) => {
    const normalized = message.toLowerCase()
    return SESSION_RESET_D1_SIGNALS.some(signal => normalized.includes(signal.toLowerCase()))
  })) {
    return { _tag: 'session-reset' }
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
  const kind = classifyD1RetryError(error)
  return kind._tag === 'session-reset' || kind._tag === 'transient'
}

function tokenizeD1Sql(sql: string): string[] {
  const tokens: string[] = []
  let index = 0

  while (index < sql.length) {
    const char = sql[index]!
    const next = sql[index + 1]

    if (char === '-' && next === '-') {
      index += 2
      while (index < sql.length && sql[index] !== '\n')
        index++
      continue
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2)
      if (end === -1)
        return []
      index = end + 2
      continue
    }
    if (char === '\'' || char === '"' || char === '`') {
      const quote = char
      index++
      while (index < sql.length) {
        if (sql[index] !== quote) {
          index++
          continue
        }
        if (sql[index + 1] === quote) {
          index += 2
          continue
        }
        index++
        break
      }
      continue
    }
    if (char === '[') {
      const end = sql.indexOf(']', index + 1)
      if (end === -1)
        return []
      index = end + 1
      continue
    }
    if (char === '(' || char === ')') {
      tokens.push(char)
      index++
      continue
    }
    if (/[A-Z_]/i.test(char)) {
      let end = index + 1
      while (end < sql.length && /[\w$]/.test(sql[end]!))
        end++
      tokens.push(sql.slice(index, end).toLowerCase())
      index = end
      continue
    }
    index++
  }

  return tokens
}

function d1StatementKeyword(sql: string): string | undefined {
  const tokens = tokenizeD1Sql(sql)
  const first = tokens[0]
  if (first !== 'with')
    return first

  let depth = 0
  for (const token of tokens.slice(1)) {
    if (token === '(') {
      depth++
      continue
    }
    if (token === ')') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0 && ['select', 'insert', 'update', 'delete', 'replace'].includes(token))
      return token
  }
}

export function isReplayableD1Sql(sql: string): boolean {
  const keyword = d1StatementKeyword(sql)
  return keyword === 'select' || keyword === 'explain'
}

type D1StatementResolver = (session: D1SessionLike) => D1StatementLike

function resolveD1Statement(statement: D1StatementLike): D1StatementResolver {
  const resolver = (statement as unknown as Record<symbol, unknown>)[D1_STATEMENT_RESOLVER]
  return typeof resolver === 'function' ? resolver as D1StatementResolver : () => statement
}

function getD1StatementSql(statement: D1StatementLike): string | undefined {
  const sql = (statement as unknown as Record<symbol, unknown>)[D1_STATEMENT_SQL]
  return typeof sql === 'string' ? sql : undefined
}

export function withD1ResetRecovery<Session extends D1SessionLike>(
  database: D1SessionSource<Session>,
  options: D1ResetRecoveryOptions = {},
): Session {
  const maxAttempts = parseMaxAttempts(options.maxAttempts ?? 3)
  const initialConstraint = consistencyConstraint(options.consistency ?? { _tag: 'first-primary' })
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? defaultSleep
  let activeSession: Session | undefined

  function currentSession(): Session {
    activeSession ??= database.withSession(initialConstraint)
    return activeSession
  }

  function renewSession(): Session {
    const bookmark = currentSession().getBookmark()
    activeSession = database.withSession(bookmark ?? initialConstraint)
    return activeSession
  }

  async function runRecoverable(
    replayable: boolean,
    sql: string,
    run: (session: Session) => unknown,
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const outcome = await Promise.resolve().then(() => run(currentSession())).then(
        value => ({ _tag: 'ok' as const, value }),
        error => ({ _tag: 'error' as const, error }),
      )
      if (outcome._tag === 'ok')
        return outcome.value

      const failure = classifyD1RetryError(outcome.error)
      if (failure._tag !== 'session-reset' && failure._tag !== 'transient')
        throw outcome.error

      const exhausted = attempt + 1 >= maxAttempts
      if (failure._tag === 'session-reset')
        renewSession()
      if (!replayable || exhausted) {
        options.onRecovery?.({
          _tag: 'stopped',
          attempt,
          failure,
          reason: exhausted ? 'attempts-exhausted' : 'unsafe-statement',
          sql,
        })
        throw outcome.error
      }

      options.onRecovery?.({ _tag: 'retrying', attempt, failure, sql })
      await sleep(retryDelay(attempt, random))
    }
  }

  function wrapStatement(
    sql: string,
    parameters: unknown[] | undefined,
    owner: Session,
    nativeStatement: D1StatementLike,
  ): D1StatementLike {
    const resolver: D1StatementResolver = (session) => {
      if (session === owner)
        return nativeStatement
      const prepared = session.prepare(sql)
      if (parameters === undefined)
        return prepared
      const bind = prepared.bind as unknown as (...values: unknown[]) => D1StatementLike
      return bind.apply(prepared, parameters)
    }

    return new Proxy(nativeStatement, {
      get(target, property) {
        if (property === D1_STATEMENT_RESOLVER)
          return resolver
        if (property === D1_STATEMENT_SQL)
          return sql
        const value = Reflect.get(target, property, target)
        if (typeof value !== 'function')
          return value
        if (property === 'bind') {
          return (...values: unknown[]) => wrapStatement(
            sql,
            values,
            owner,
            (value as (...args: unknown[]) => D1StatementLike).apply(target, values),
          )
        }
        if (typeof property === 'string' && D1_TERMINAL_METHODS.has(property)) {
          return (...args: unknown[]) => runRecoverable(
            isReplayableD1Sql(sql),
            sql,
            (session) => {
              const statement = resolver(session)
              const method = Reflect.get(statement, property, statement) as (...values: unknown[]) => unknown
              return method.apply(statement, args)
            },
          )
        }
        return (value as (...args: unknown[]) => unknown).bind(target)
      },
    })
  }

  const facade = {
    prepare(sql: string) {
      const session = currentSession()
      return wrapStatement(sql, undefined, session, session.prepare(sql))
    },
    batch(statements: D1StatementLike[]) {
      const resolvers = statements.map(resolveD1Statement)
      const replayable = statements.length > 0 && statements.every((statement) => {
        const sql = getD1StatementSql(statement)
        return sql !== undefined && isReplayableD1Sql(sql)
      })
      return runRecoverable(
        replayable,
        `batch(${statements.length})`,
        (session) => {
          const batch = session.batch as unknown as (statements: D1StatementLike[]) => unknown
          return batch.call(session, resolvers.map(resolve => resolve(session)))
        },
      )
    },
  }

  return new Proxy(facade, {
    get(target, property, receiver) {
      if (Reflect.has(target, property))
        return Reflect.get(target, property, receiver)
      const session = currentSession() as unknown as Record<PropertyKey, unknown>
      const value = session[property]
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(session)
        : value
    },
  }) as unknown as Session
}

export function getRequestD1Session<Session>(
  requestContext: Record<PropertyKey, unknown>,
  binding: string,
  database: D1SessionSource<Session>,
  consistency: D1Consistency = { _tag: 'first-primary' },
): Session {
  const sessions = getD1SessionCache(requestContext, REQUEST_D1_SESSIONS)
  const constraint = consistencyConstraint(consistency)
  const key = `${binding}:${constraint}`
  if (!sessions.has(key))
    sessions.set(key, database.withSession(constraint))
  return sessions.get(key) as Session
}

export function getRecoveringRequestD1Session<Session extends D1SessionLike>(
  requestContext: Record<PropertyKey, unknown>,
  binding: string,
  database: D1SessionSource<Session>,
  options: D1ResetRecoveryOptions = {},
): Session {
  const consistency = options.consistency ?? { _tag: 'first-primary' }
  const key = `${binding}:${consistencyConstraint(consistency)}`
  const sessions = getD1SessionCache(requestContext, REQUEST_D1_RECOVERING_SESSIONS)
  if (!sessions.has(key)) {
    sessions.set(key, withD1ResetRecovery(database, {
      ...options,
      consistency,
    }))
  }
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
      || ((kind._tag === 'session-reset' || kind._tag === 'transient')
        && options.safety._tag === 'replay-safe')
    if (!retryable || attempt + 1 >= maxAttempts)
      throw outcome.error
    await sleep(retryDelay(attempt, random))
  }

  throw lastError
}
