export type WideEventValue = boolean | null | number | string

declare global {
  interface NuxtWideEventFields {}
}

export type ConfiguredWideEventField = Extract<keyof NuxtWideEventFields, string>
export type WideEventFields = [ConfiguredWideEventField] extends [never]
  ? Record<string, never>
  : Partial<Record<ConfiguredWideEventField, WideEventValue>>

export interface WideEventRecord extends Record<string, WideEventValue | undefined> {
  durationMs: number
  level: 'debug' | 'error' | 'info' | 'warn'
  method: string
  requestId: string
  status: number
  timestamp: string
  path?: string
  service?: string
}

export interface WideEventLike {
  context: Record<string, unknown>
  method?: string
  path?: string
}

const STATE_KEY = Symbol.for('@harlan-zw/nuxt-wide-events/state')
const STARTED_AT_KEY = Symbol('startedAt')
const REQUEST_ID_KEY = Symbol('requestId')
const ERROR_KEY = Symbol('error')
const COLLECTING = Symbol('collecting')
const EMITTED = Symbol('emitted')

type CollectingWideEvent = Record<string, WideEventValue | undefined>

type WideEventState = CollectingWideEvent | typeof COLLECTING | typeof EMITTED

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

/** Record an error without ending Field collection. */
export function captureWideEventError(event: WideEventLike, _error: unknown): void {
  const context = stateContext(event)
  const current = context[STATE_KEY] as WideEventState | undefined
  if (current === EMITTED)
    return
  if (current === undefined) {
    initializeMetadata(context)
    context[STATE_KEY] = COLLECTING
  }
  context[ERROR_KEY] = true
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
  const current = context[STATE_KEY] as WideEventState | undefined
  if (current === EMITTED)
    return null

  if (current === undefined)
    initializeMetadata(context)
  const state = current === undefined || current === COLLECTING ? {} : current
  const record = state as WideEventRecord
  record.timestamp = timestamp
  record.level = context[ERROR_KEY] === true ? 'error' : 'info'
  if (service !== undefined)
    record.service = service
  record.method = safeMethod(event.method)
  if (path !== undefined)
    record.path = path
  record.status = status
  record.durationMs = Math.max(0, endedAt - (context[STARTED_AT_KEY] as number))
  record.requestId = context[REQUEST_ID_KEY] as string
  context[STATE_KEY] = EMITTED
  return record
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
