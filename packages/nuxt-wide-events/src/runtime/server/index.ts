export type WideEventValue = boolean | null | number | string

declare global {
  interface NuxtWideEventFields {}
}

export type ConfiguredWideEventField = Extract<keyof NuxtWideEventFields, string>
export type WideEventFields = [ConfiguredWideEventField] extends [never]
  ? Record<string, never>
  : Partial<Record<ConfiguredWideEventField, WideEventValue>>

/** Severity of one Wide Event, from lowest to highest. */
export type WideEventLevel = 'debug' | 'info' | 'warn' | 'error'

/** Source of one Wide Event. */
export type WideEventKind = 'background' | 'request'

interface WideEventRecordBase extends Record<string, WideEventValue | undefined> {
  durationMs: number
  kind: WideEventKind
  level: WideEventLevel
  requestId: string
  timestamp: string
  service?: string
}

/** One Wide Event for one request. */
export interface WideEventRecord extends WideEventRecordBase {
  kind: 'request'
  method: string
  status: number
  path?: string
}

/** One Wide Event for one background operation, which has no method, path, or status. */
export interface BackgroundWideEventRecord extends WideEventRecordBase {
  kind: 'background'
}

export interface WideEventLike {
  context: Record<string, unknown>
  method?: string
  path?: string
}

const STATE_KEY = Symbol.for('@harlan-zw/nuxt-wide-events/state')
const STARTED_AT_KEY = Symbol('startedAt')
const REQUEST_ID_KEY = Symbol('requestId')
const LEVEL_KEY = Symbol('level')
const COLLECTING = Symbol('collecting')
const EMITTED = Symbol('emitted')

type CollectingWideEvent = Record<string, WideEventValue | undefined>

type WideEventState = CollectingWideEvent | typeof COLLECTING | typeof EMITTED

const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 } as const

export function startWideEvent(event: WideEventLike, requestId?: string, startedAt?: number): void {
  const context = stateContext(event)
  const current = context[STATE_KEY] as WideEventState | undefined
  if (current === EMITTED)
    throw new Error('The Wide Event was already emitted.')
  if (current)
    return

  context[STATE_KEY] = COLLECTING
  context[REQUEST_ID_KEY] = requestId ?? crypto.randomUUID()
  context[STARTED_AT_KEY] = startedAt ?? performance.now()
}

export function addWideEventFields(event: WideEventLike, fields: WideEventFields): void
export function addWideEventFields(event: WideEventLike, fields: WideEventFields, owned = false): void {
  const context = stateContext(event)
  const current = context[STATE_KEY] as WideEventState | undefined
  if (current === EMITTED)
    throw new Error('The Wide Event was already emitted.')

  const firstFields = current === undefined || current === COLLECTING
  if (owned && firstFields && Object.getPrototypeOf(fields) !== Object.prototype)
    throw new TypeError('Compiler-owned Wide Event Fields must be a plain object literal.')

  const output = !owned && firstFields ? {} as CollectingWideEvent : undefined
  let undefinedFields: string[] | undefined
  for (const field in fields) {
    if (!Object.hasOwn(fields, field))
      continue
    const value = fields[field as ConfiguredWideEventField]
    if (value === undefined) {
      if (owned) {
        undefinedFields ??= []
        undefinedFields.push(field)
      }
      continue
    }
    if (!isWideEventValue(value))
      throw new TypeError(`Wide Event field "${field}" must be a string, number, boolean, or null.`)
    if (output)
      output[field] = value
    else if (!firstFields)
      current[field] = value
  }
  if (undefinedFields) {
    if (owned) {
      for (const field of undefinedFields)
        delete fields[field as ConfiguredWideEventField]
    }
  }

  if (current === undefined) {
    initializeMetadata(context)
  }
  if (current === undefined || current === COLLECTING) {
    context[STATE_KEY] = owned ? fields : output!
  }
}

/**
 * Raise the level of one Wide Event without ending Field collection.
 *
 * The record keeps the highest level it receives. A recovered error stays an
 * error, so a later `info` cannot hide it from a drain or a sampling rate.
 */
export function setWideEventLevel(event: WideEventLike, level: WideEventLevel): void {
  if (!Object.hasOwn(LEVEL_RANK, level))
    throw new TypeError('Wide Event level must be debug, error, info, or warn.')
  const context = stateContext(event)
  if (context[STATE_KEY] === EMITTED)
    throw new Error('The Wide Event was already emitted.')
  raiseLevel(context, level)
}

/** Record an error without ending Field collection. */
export function captureWideEventError(event: WideEventLike, _error: unknown): void {
  const context = stateContext(event)
  if (context[STATE_KEY] === EMITTED)
    return
  raiseLevel(context, 'error')
}

export function emitWideEvent(
  event: WideEventLike,
  status = 200,
  service?: string,
  path?: string,
  endedAt = performance.now(),
  timestamp = new Date().toISOString(),
): WideEventRecord | null {
  const context = stateContext(event)
  const record = finalizeWideEvent(context, service, timestamp) as WideEventRecord | null
  if (!record)
    return null
  record.kind = 'request'
  record.method = safeMethod(event.method)
  if (path !== undefined)
    record.path = path
  record.status = status
  record.durationMs = Math.max(0, endedAt - (context[STARTED_AT_KEY] as number))
  record.requestId = context[REQUEST_ID_KEY] as string
  return record
}

/** Emit one Wide Event for a background operation, which has no method, path, or status. */
export function emitBackgroundWideEvent(
  event: WideEventLike,
  service?: string,
  endedAt = performance.now(),
  timestamp = new Date().toISOString(),
): BackgroundWideEventRecord | null {
  const context = stateContext(event)
  const record = finalizeWideEvent(context, service, timestamp) as BackgroundWideEventRecord | null
  if (!record)
    return null
  record.kind = 'background'
  record.durationMs = Math.max(0, endedAt - (context[STARTED_AT_KEY] as number))
  record.requestId = context[REQUEST_ID_KEY] as string
  return record
}

function finalizeWideEvent(
  context: Record<PropertyKey, unknown>,
  service: string | undefined,
  timestamp: string,
): WideEventRecordBase | null {
  const current = context[STATE_KEY] as WideEventState | undefined
  if (current === EMITTED)
    return null

  if (current === undefined)
    initializeMetadata(context)
  const state = current === undefined || current === COLLECTING ? {} : current
  const record = state as WideEventRecordBase
  record.timestamp = timestamp
  record.level = (context[LEVEL_KEY] as WideEventLevel | undefined) ?? 'info'
  if (service !== undefined)
    record.service = service
  context[STATE_KEY] = EMITTED
  return record
}

function raiseLevel(context: Record<PropertyKey, unknown>, level: WideEventLevel): void {
  if (context[STATE_KEY] === undefined) {
    initializeMetadata(context)
    context[STATE_KEY] = COLLECTING
  }
  const current = context[LEVEL_KEY] as WideEventLevel | undefined
  if (current === undefined || LEVEL_RANK[level] > LEVEL_RANK[current])
    context[LEVEL_KEY] = level
}

function stateContext(event: WideEventLike): Record<PropertyKey, unknown> {
  return event.context as Record<PropertyKey, unknown>
}

function initializeMetadata(context: Record<PropertyKey, unknown>): void {
  context[REQUEST_ID_KEY] = crypto.randomUUID()
  context[STARTED_AT_KEY] = performance.now()
}

function isWideEventValue(value: unknown): value is WideEventValue {
  if (value === null)
    return true
  const type = typeof value
  return type === 'boolean' || type === 'number' || type === 'string'
}

function safeMethod(method: string | undefined): string {
  switch (method) {
    case 'CONNECT':
    case 'DELETE':
    case 'GET':
    case 'HEAD':
    case 'OPTIONS':
    case 'PATCH':
    case 'POST':
    case 'PUT':
    case 'TRACE':
      return method
    default:
      return 'UNKNOWN'
  }
}
