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
  level: 'error' | 'info'
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
const EMITTED = Symbol('emitted')

type CollectingWideEvent = Record<string, WideEventValue | undefined>

type WideEventState = CollectingWideEvent | typeof EMITTED

export function startWideEvent(event: WideEventLike, requestId?: string, startedAt?: number): void {
  const context = stateContext(event)
  const current = context[STATE_KEY] as WideEventState | undefined
  if (current === EMITTED)
    throw new Error('The Wide Event was already emitted.')
  if (current)
    return

  context[STATE_KEY] = createCollectingState()
  context[REQUEST_ID_KEY] = requestId ?? crypto.randomUUID()
  context[STARTED_AT_KEY] = startedAt ?? performance.now()
}

export function addWideEventFields(event: WideEventLike, fields: WideEventFields): void {
  const state = collectingState(event)
  for (const field in fields) {
    const value = fields[field as ConfiguredWideEventField]
    if (!isWideEventValue(value))
      throw new TypeError(`Wide Event field "${field}" must be a string, number, boolean, or null.`)
    state[field] = value
  }
}

/** Record an error without ending Field collection. */
export function captureWideEventError(event: WideEventLike, _error: unknown): void {
  const context = stateContext(event)
  if (context[STATE_KEY] === EMITTED)
    return
  collectingState(event)
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

  const state = current ?? initializeCollectingState(context)
  const hasError = context[ERROR_KEY] === true
  const record = state as WideEventRecord
  record.timestamp = timestamp
  record.level = hasError ? 'error' : 'info'
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

function collectingState(event: WideEventLike): CollectingWideEvent {
  const context = stateContext(event)
  const current = context[STATE_KEY] as WideEventState | undefined
  if (current === EMITTED)
    throw new Error('The Wide Event was already emitted.')
  if (current)
    return current
  return initializeCollectingState(context)
}

function stateContext(event: WideEventLike): Record<PropertyKey, unknown> {
  return event.context as Record<PropertyKey, unknown>
}

function createCollectingState(): CollectingWideEvent {
  return {}
}

function initializeCollectingState(context: Record<PropertyKey, unknown>): CollectingWideEvent {
  const state = createCollectingState()
  context[STATE_KEY] = state
  context[REQUEST_ID_KEY] = crypto.randomUUID()
  context[STARTED_AT_KEY] = performance.now()
  return state
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
