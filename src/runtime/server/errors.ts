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

const eventRuntimeErrors = new WeakSet<Error>()

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
  eventRuntimeErrors.add(error)
  return error
}

export function isEventRuntimeError(error: unknown): error is EventRuntimeError {
  return error instanceof Error && eventRuntimeErrors.has(error)
}
