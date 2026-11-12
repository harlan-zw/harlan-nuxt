import { isTransientD1Error } from '@harlan-zw/nuxt-cloudflare/d1'
import { isDurableJobOwnershipError } from './errors'

/** The lifecycle write that settles a claimed row. */
export type DurableJobLifecycleWrite = 'complete' | 'fail' | 'release' | 'settlement'

/**
 * A lifecycle write that stayed transient after its in-process retries. The row
 * keeps its reservation, and the message is retried after `delaySeconds`.
 */
export interface DurableJobWriteDeferral {
  write: DurableJobLifecycleWrite
  /** Calls made, the first one included. */
  tries: number
  delaySeconds: number
  cause: unknown
  /** Present when the follow-up work was requeued on a settlement message. */
  settlement?: DurableJobPendingSettlement
}

/** A terminal outcome whose follow-up work (settlement, continuations) has not run. */
export type DurableJobSettlementStatus = 'completed' | 'failed' | 'exhausted' | 'dispatch-failed'

/**
 * Marker on a requeued queue message. It names the claim (`attempts`) whose
 * terminal write may have landed with its response lost.
 */
export interface DurableJobPendingSettlement {
  status: DurableJobSettlementStatus
  attempts: number
}

/** Persisted state of one claim's write, read once after an ambiguous failure. */
export type LifecycleWriteConfirmation = 'landed' | 'not-landed'

const SETTLEMENT_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'exhausted', 'dispatch-failed'])

/** Parse the settlement marker from an untrusted queue message body. */
export function readPendingSettlement(body: unknown): DurableJobPendingSettlement | null {
  if (typeof body !== 'object' || body === null || !('settlement' in body))
    return null
  const marker = body.settlement
  if (typeof marker !== 'object' || marker === null || !('status' in marker) || !('attempts' in marker))
    return null
  const { status, attempts } = marker
  if (typeof status !== 'string' || !SETTLEMENT_STATUSES.has(status) || typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 1)
    return null
  return { status: status as DurableJobSettlementStatus, attempts }
}

/** Classifies a thrown lifecycle write. Same input shape as `isPermanentFailure`. */
export type IsTransientError = (input: { error: unknown }) => boolean

export interface LifecycleWriteRetryOptions {
  /** In-process retries after the first transient failure. Default 2. */
  retries?: number
  /** Wait before retry `n` (1-based). Default 100ms, then 400ms. */
  backoffMs?: (retry: number) => number
  /**
   * Delay before the message is redelivered once retries are spent. The row is
   * still reserved, so a redelivery can claim it only after the reservation
   * window. `createDurableJobsRuntime` defaults this to `reclaimAfterSeconds`.
   * Default 60.
   */
  redeliveryDelaySeconds?: number
}

export type LifecycleWriteOutcome
  = | { _tag: 'written' }
    | { _tag: 'obsolete' }
    | { _tag: 'deferred', deferral: DurableJobWriteDeferral }
    /** The write may have landed, and the read that would tell failed too. */
    | { _tag: 'unconfirmed', deferral: DurableJobWriteDeferral }

const DEFAULT_RETRIES = 2
const DEFAULT_REDELIVERY_DELAY_SECONDS = 60
const MAX_REDELIVERY_DELAY_SECONDS = 43200
const MAX_CAUSE_DEPTH = 8

// D1 sheds load with these messages before it runs the statement. See
// https://developers.cloudflare.com/d1/observability/debug-d1/ (error 7429).
// "generating too much load" is the account-wide form.
const D1_OVERLOAD_SIGNALS = ['d1 db is overloaded', 'generating too much load']

function causeMessages(error: unknown): string[] {
  const messages: string[] = []
  const seen = new Set<unknown>()
  let current = error
  while (current !== undefined && current !== null && messages.length < MAX_CAUSE_DEPTH && !seen.has(current)) {
    seen.add(current)
    if (typeof current !== 'object') {
      messages.push(String(current))
      break
    }
    if ('message' in current && typeof current.message === 'string')
      messages.push(current.message)
    current = 'cause' in current ? current.cause : undefined
  }
  return messages
}

/**
 * Default {@link IsTransientError}: a D1 overload, a lost connection, or a
 * storage reset, read through the `cause` chain. Memory, CPU, and SQL errors
 * stay permanent, because the same write fails the same way again.
 */
export const isTransientD1WriteError: IsTransientError = ({ error }) => {
  const messages = causeMessages(error).map(message => message.toLowerCase())
  return messages.some(message => D1_OVERLOAD_SIGNALS.some(signal => message.includes(signal)))
    || isTransientD1Error(error)
}

function defaultBackoffMs(retry: number): number {
  return 100 * 4 ** (retry - 1)
}

export function resolveRedeliveryDelaySeconds(seconds: number | undefined): number {
  const requested = seconds ?? DEFAULT_REDELIVERY_DELAY_SECONDS
  if (!Number.isFinite(requested) || requested < 0)
    return DEFAULT_REDELIVERY_DELAY_SECONDS
  return Math.min(Math.ceil(requested), MAX_REDELIVERY_DELAY_SECONDS)
}

/**
 * Run one lifecycle write with bounded retries on transient failures.
 *
 * - An ownership miss on the first call means another run owns the row: `obsolete`.
 * - An ownership miss on a retry, or a transient failure on the final try, is
 *   ambiguous: a call may have committed and lost its response ("Network
 *   connection lost"). `confirm` reads the row once. `landed` is `written`.
 *   `not-landed` is `obsolete` after an ownership miss and `deferred` after
 *   a transient failure. A transient read failure is `unconfirmed`.
 * - Without `confirm`, an ownership miss on a retry counts as `written` and
 *   a final transient failure is `deferred`.
 * - Any other failure is a defect and propagates.
 */
export async function runLifecycleWrite(input: {
  write: DurableJobLifecycleWrite
  run: () => Promise<unknown>
  /** One bounded read of this claim's persisted write. */
  confirm?: () => Promise<LifecycleWriteConfirmation>
  isTransientError?: IsTransientError
  retry?: LifecycleWriteRetryOptions
  sleep?: (ms: number) => Promise<void>
}): Promise<LifecycleWriteOutcome> {
  const isTransient = input.isTransientError ?? isTransientD1WriteError
  const requestedRetries = input.retry?.retries ?? DEFAULT_RETRIES
  const retries = Number.isFinite(requestedRetries) ? Math.max(0, Math.floor(requestedRetries)) : DEFAULT_RETRIES
  const backoffMs = input.retry?.backoffMs ?? defaultBackoffMs
  const sleep = input.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const deferral = (tries: number, cause: unknown): DurableJobWriteDeferral => ({
    write: input.write,
    tries,
    delaySeconds: resolveRedeliveryDelaySeconds(input.retry?.redeliveryDelaySeconds),
    cause,
  })
  const confirm = async (tries: number, cause: unknown, notLanded: LifecycleWriteOutcome): Promise<LifecycleWriteOutcome> => {
    if (!input.confirm)
      return notLanded
    const read = await input.confirm().then(
      (confirmation): { confirmation: LifecycleWriteConfirmation } => ({ confirmation }),
      (readCause: unknown) => {
        if (!isTransient({ error: readCause }))
          throw readCause
        return null
      },
    )
    if (!read)
      return { _tag: 'unconfirmed', deferral: deferral(tries, cause) }
    return read.confirmation === 'landed' ? { _tag: 'written' } : notLanded
  }
  let tries = 0
  for (;;) {
    tries++
    const failure = await input.run().then(() => null, (cause: unknown) => ({ cause }))
    if (!failure)
      return { _tag: 'written' }
    if (isDurableJobOwnershipError(failure.cause)) {
      if (tries === 1)
        return { _tag: 'obsolete' }
      return input.confirm ? await confirm(tries, failure.cause, { _tag: 'obsolete' }) : { _tag: 'written' }
    }
    if (!isTransient({ error: failure.cause }))
      throw failure.cause
    if (tries > retries)
      return await confirm(tries, failure.cause, { _tag: 'deferred', deferral: deferral(tries, failure.cause) })
    await sleep(backoffMs(tries))
  }
}
