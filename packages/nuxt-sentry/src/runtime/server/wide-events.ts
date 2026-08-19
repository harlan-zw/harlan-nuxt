/**
 * The two directions this module shares with `@harlan-zw/nuxt-wide-events`.
 *
 * The two packages keep different halves of the same failure and must not
 * duplicate each other. `nuxt-wide-events` discards the error object in
 * production and keeps only a level, so a Sentry report cannot be built from a
 * Wide Event. Sentry keeps the exception, the stack and the request scope.
 *
 * So Sentry never reads a Wide Event to build a report. It reads one to emit a
 * LOG, which is a separate quota, and it writes the trace identity back so a
 * Wide Event and a Sentry report can be joined.
 */

import type { WideEventDrainPolicy, WideEventLogLevel } from '../shared/types'

/** The Wide Event record shape this module reads. Structural, so no import is needed. */
export interface DrainedWideEvent {
  level?: string
  service?: string
  name?: string
  [key: string]: unknown
}

export type WideEventLogDecision
  = | { _tag: 'skip' }
    | { _tag: 'log', level: WideEventLogLevel, message: string, attributes: Record<string, unknown> }

/**
 * Whether a drained Wide Event becomes a Sentry log.
 *
 * Only a failing record, and only at a level the site opted into. A successful
 * request is already a Wide Event in the site's own sink, and mirroring every
 * one of them into Sentry Logs would spend the byte quota on records nobody
 * reads.
 */
export function decideWideEventLog(
  record: DrainedWideEvent,
  policy: WideEventDrainPolicy,
): WideEventLogDecision {
  const level = record.level
  if (level !== 'error' && level !== 'warn')
    return { _tag: 'skip' }
  if (!policy.levels.includes(level))
    return { _tag: 'skip' }

  const name = typeof record.name === 'string' && record.name ? record.name : 'wide-event'
  const attributes: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key === 'level' || key === 'name')
      continue
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value))
      attributes[key] = value
  }
  return { _tag: 'log', level, message: name, attributes }
}

/** The Wide Event fields this module populates. Must match the build hook declaration. */
export interface SentryCorrelation {
  'sentry.traceId': string | null
  'sentry.spanId': string | null
}

interface TraceDataLike {
  'sentry-trace'?: unknown
}

/**
 * Parse `getTraceData()` into the two correlation fields.
 *
 * The SDK returns a `sentry-trace` header, `<traceId>-<spanId>-<sampled>`.
 * Reading it rather than the span object keeps this a pure string parse that a
 * test can drive without a live Sentry client.
 */
export function parseSentryCorrelation(traceData: unknown): SentryCorrelation {
  const header = (traceData as TraceDataLike | undefined)?.['sentry-trace']
  if (typeof header !== 'string')
    return { 'sentry.traceId': null, 'sentry.spanId': null }
  const [traceId, spanId] = header.split('-')
  return {
    'sentry.traceId': traceId || null,
    'sentry.spanId': spanId || null,
  }
}
