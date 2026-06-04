// The typed error (`E`) channel for the durable-job lifecycle, lifted from
// Effect's tagged-error idea. Every *expected* failure in preparing or
// dispatching a job is a value with a `_tag` discriminant and the data needed to
// act on it, never a bare `throw new Error('...')`. Call sites `switch` on `_tag`
// exhaustively instead of pattern-matching error message strings.
//
// `cause: unknown` carries the underlying validation error / thrown defect so it
// is never lost; `message` is a human-readable rendering for logs and for the
// throwing wrappers that re-raise these as `Error`s.

export interface NoTaskError {
  readonly _tag: 'no-task'
  readonly message: string
}

export interface HandlerNotFoundError {
  readonly _tag: 'handler-not-found'
  readonly task: string
  readonly message: string
}

export interface InvalidPayloadError {
  readonly _tag: 'invalid-payload'
  readonly task: string
  readonly cause: unknown
  readonly message: string
}

export interface PayloadTooLargeError {
  readonly _tag: 'payload-too-large'
  readonly task: string
  readonly bytes: number
  readonly limit: number
  readonly message: string
}

export interface NoRouteError {
  readonly _tag: 'no-route'
  readonly task: string
  readonly message: string
}

export interface UnknownContinuationError {
  readonly _tag: 'unknown-continuation'
  readonly task: string
  readonly message: string
}

export interface InvalidContinuationError {
  readonly _tag: 'invalid-continuation'
  readonly task: string
  readonly cause: unknown
  readonly message: string
}

export interface ContinuationQueueMismatchError {
  readonly _tag: 'continuation-queue-mismatch'
  readonly task: string
  readonly expected: string
  readonly received: string
  readonly message: string
}

/** A handler threw an unexpected defect that a runner chose to capture as a value. */
export interface HandlerThrewError {
  readonly _tag: 'handler-threw'
  readonly task?: string
  readonly cause: unknown
  readonly message: string
}

export type JobError
  = | NoTaskError
    | HandlerNotFoundError
    | InvalidPayloadError
    | PayloadTooLargeError
    | NoRouteError
    | UnknownContinuationError
    | InvalidContinuationError
    | ContinuationQueueMismatchError
    | HandlerThrewError

export type JobErrorTag = JobError['_tag']

export function isJobError(value: unknown): value is JobError {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { _tag?: unknown })._tag === 'string'
    && typeof (value as { message?: unknown }).message === 'string'
}

/** Renders any defect into a string for `message` fields and string-only sinks. */
export function describeCause(cause: unknown): string {
  if (cause instanceof Error)
    return cause.message
  return typeof cause === 'string' ? cause : String(cause)
}

export const jobErrors = {
  noTask(): NoTaskError {
    return { _tag: 'no-task', message: 'No _task in payload' }
  },
  handlerNotFound(task: string): HandlerNotFoundError {
    return { _tag: 'handler-not-found', task, message: `No handler for task: ${task}` }
  },
  invalidPayload(task: string, cause?: unknown): InvalidPayloadError {
    return { _tag: 'invalid-payload', task, cause, message: `Invalid payload for task: ${task}` }
  },
  payloadTooLarge(task: string, bytes: number, limit: number): PayloadTooLargeError {
    return {
      _tag: 'payload-too-large',
      task,
      bytes,
      limit,
      message: `Job payload exceeds Cloudflare Queue limit of ${limit} bytes for task: ${task}`,
    }
  },
  noRoute(task: string): NoRouteError {
    return { _tag: 'no-route', task, message: `No route for task: ${task}` }
  },
  unknownContinuation(task: string): UnknownContinuationError {
    return { _tag: 'unknown-continuation', task, message: `No handler for continuation task: ${task}` }
  },
  invalidContinuation(task: string, cause?: unknown): InvalidContinuationError {
    return { _tag: 'invalid-continuation', task, cause, message: `Invalid payload for continuation task: ${task}` }
  },
  continuationQueueMismatch(task: string, expected: string, received: string): ContinuationQueueMismatchError {
    return {
      _tag: 'continuation-queue-mismatch',
      task,
      expected,
      received,
      message: `Continuation task "${task}" is registered on queue "${expected}", not "${received}"`,
    }
  },
  handlerThrew(cause: unknown, task?: string): HandlerThrewError {
    return { _tag: 'handler-threw', task, cause, message: describeCause(cause) }
  },
} as const

/** The human-readable rendering of a `JobError`, for logs and string sinks. */
export function formatJobError(error: JobError): string {
  return error.message
}

/** Re-raises a `JobError` as an `Error`, preserving its `cause` for stack-walking. */
export function jobErrorToException(error: JobError): Error {
  const exception = new Error(error.message)
  if ('cause' in error && error.cause !== undefined)
    (exception as Error & { cause?: unknown }).cause = error.cause
  ;(exception as Error & { jobError?: JobError }).jobError = error
  return exception
}
