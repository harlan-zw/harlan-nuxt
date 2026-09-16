export type EventRuntimeErrorTag
  = 'UnknownEvent'
    | 'EventContractImportFailure'
    | 'EventPayloadMismatch'
    | 'EventPayloadEncodingFailure'
    | 'EventPayloadTooLarge'
    | 'ListenerImportFailure'
    | 'ListenerPayloadMismatch'
    | 'RegistryDrift'
    | 'ListenerFailure'
    | 'DeferredRuntimeMissing'
    | 'QueueAdapterMissing'
    | 'QueueDispatchFailure'
    | 'AfterCommitRequired'
    | 'EventPlanAlreadyCommitted'
    | 'EventPlanQueueMismatch'
    | 'InvalidQueuedDelivery'
    | 'IdempotencyFailure'

export type EventRuntimeError = Error & {
  _tag: EventRuntimeErrorTag
  cause?: unknown
  details?: Record<string, unknown>
}

// A well-known symbol, not a WeakSet: pnpm can resolve two copies of this
// package across workspace layers (a peer hash change is enough), and each
// copy's module scope gets its own WeakSet. An error thrown by one copy's
// eventRuntimeError() then failed instanceof/has() checks against the
// other copy's isEventRuntimeError() (incident 2026-09-15, nuxtseo.com#969).
// Symbol.for() is registry-keyed by string, so every copy resolves the same
// symbol regardless of which module instance created it.
const EVENT_RUNTIME_ERROR_BRAND = Symbol.for('@harlan-zw/nuxt-domain-events/runtime-error')

export function eventRuntimeError(
  tag: EventRuntimeErrorTag,
  message: string,
  options: { cause?: unknown, details?: Record<string, unknown> } = {},
): EventRuntimeError {
  const error = Object.assign(new Error(message), {
    _tag: tag,
    ...(options.cause === undefined ? {} : { cause: options.cause }),
    ...(options.details === undefined ? {} : { details: options.details }),
  })
  Object.defineProperty(error, EVENT_RUNTIME_ERROR_BRAND, {
    value: true,
    enumerable: false,
  })
  return error
}

export function isEventRuntimeError(error: unknown): error is EventRuntimeError {
  return error instanceof Error
    && (error as unknown as Record<symbol, unknown>)[EVENT_RUNTIME_ERROR_BRAND] === true
    && typeof (error as { _tag?: unknown })._tag === 'string'
}
