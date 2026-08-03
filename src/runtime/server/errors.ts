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

/**
 * The claim step itself threw (e.g. the backing store was overloaded) before any
 * handler could run. Distinct from `handler-threw`: no dispatch happened, so the
 * message is simply retried with backoff rather than counted toward the attempt
 * cap. Capturing it as a value lets the consumer shed load instead of letting the
 * throw escape and fail every sibling message in the batch.
 */
export interface ClaimThrewError {
  readonly _tag: 'claim-threw'
  readonly cause: unknown
  readonly message: string
}

export class DurableJobOwnershipError extends Error {
  constructor(readonly jobId: string) {
    super(`Durable job reservation is no longer owned by this worker: ${jobId}`)
    this.name = 'DurableJobOwnershipError'
  }
}

export function isDurableJobOwnershipError(error: unknown): error is DurableJobOwnershipError {
  return error instanceof DurableJobOwnershipError
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
    | ClaimThrewError

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

/** Upper bound on a rendered stack, so one defect can't blow up a `failed_jobs` row. */
export const MAX_DESCRIBED_STACK_CHARS = 4000

/** Per-link cap when a chain is rendered headline-first, so one long message can't crowd out the rest. */
const MAX_HEADLINE_CHARS = 500

/**
 * The first line of a rendered defect — `"TypeError: <message>"` for anything that
 * came through {@link describeCauseWithStack}, and the string itself for a plain
 * single-line message. Telemetry sinks (Sentry issue titles, realtime payloads)
 * want this, not the whole stack.
 */
export function headlineOf(rendered: string): string {
  const newline = rendered.indexOf('\n')
  return newline === -1 ? rendered : rendered.slice(0, newline)
}

/**
 * Renders a defect for DIAGNOSTICS — the stack, plus the `cause` chain beneath it.
 *
 * `describeCause` deliberately collapses an `Error` to its `.message`, which is the
 * right rendering for the short `message` fields of a `JobError`. But it is also what
 * used to land in `failed_jobs.exception`, so a terminal failure was persisted as a
 * bare sentence with no stack and no cause — undiagnosable without reproducing it
 * (this is how a `TypeError: Cannot assign to read only property 'name'` sat in the
 * crawl queue for 103 occurrences with nothing to point at). Use this at the
 * persistence / observability boundary; keep `describeCause` for `message`.
 *
 * `error.stack` already begins with `"<name>: <message>"`, so it is used whole when
 * present and synthesised otherwise. Cycles and runaway chains are bounded.
 *
 * Over budget, the HEADLINE of every chain link is rendered first and stacks fill
 * whatever remains. Truncating the joined render from the front instead would delete
 * the deepest cause, which is the one thing worth keeping: a `DrizzleQueryError`
 * embeds the whole failing SQL and bind params in its own stack, so link 1 alone can
 * exceed the budget and the real driver error underneath never reaches the row.
 */
export function describeCauseWithStack(cause: unknown, maxChars: number = MAX_DESCRIBED_STACK_CHARS): string {
  const chain: unknown[] = []
  const seen = new Set<unknown>()
  let current: unknown = cause

  while (current !== undefined && current !== null && chain.length < 5) {
    if (typeof current === 'object') {
      if (seen.has(current))
        break
      seen.add(current)
    }
    if (current instanceof Error) {
      chain.push(current)
      current = (current as Error & { cause?: unknown }).cause
      continue
    }
    chain.push(current)
    break
  }

  const rendered = chain
    .map(link => link instanceof Error ? link.stack || `${link.name}: ${link.message}` : describeCause(link))
    .join('\nCaused by: ') || describeCause(cause)
  if (rendered.length <= maxChars)
    return rendered

  const headlines = chain
    .map((link) => {
      const text = link instanceof Error ? `${link.name}: ${link.message}` : describeCause(link)
      return text.length > MAX_HEADLINE_CHARS ? `${text.slice(0, MAX_HEADLINE_CHARS)}…` : text
    })
    .join('\nCaused by: ') || describeCause(cause)
  const remaining = maxChars - headlines.length
  if (remaining <= 0)
    return headlines.length > maxChars ? `${headlines.slice(0, maxChars)}\n… (truncated)` : headlines

  return `${headlines}\n${rendered.slice(0, remaining)}\n… (truncated)`
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
      message: `Job payload exceeds durable storage limit of ${limit} bytes for task: ${task}`,
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
  claimThrew(cause: unknown): ClaimThrewError {
    return { _tag: 'claim-threw', cause, message: describeCause(cause) }
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
