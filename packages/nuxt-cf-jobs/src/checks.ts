import type { Check, CheckContext } from '@harlan-zw/nuxt-checkin/server'
import { defineCheck, fail, pass, unavailable, warn } from '@harlan-zw/nuxt-checkin/server'
import { resolveCloudflareBindings } from '@harlan-zw/nuxt-cloudflare/bindings'
import { backpressureSql } from './cli/queries'

export interface QueueCheckOptions {
  id: string
  d1Binding: string
  queue: string
  warnAfterSeconds: number
  failAfterSeconds: number
  staleAfterSeconds?: number
}

interface QueueEvidence {
  queue: string
  ready: number
  reserved: number
  delayed: number
  oldestDueAgeSeconds: number | null
  oldestReservationAgeSeconds: number | null
}

export function evaluateQueueCheck(evidence: QueueEvidence, options: Pick<QueueCheckOptions, 'warnAfterSeconds' | 'failAfterSeconds' | 'staleAfterSeconds'>) {
  if (evidence.oldestReservationAgeSeconds !== null && options.staleAfterSeconds !== undefined && evidence.oldestReservationAgeSeconds >= options.staleAfterSeconds)
    return fail('Queue has a stale reservation.', { ...evidence })
  if (evidence.oldestDueAgeSeconds !== null && evidence.oldestDueAgeSeconds >= options.failAfterSeconds)
    return fail('Due queue work exceeded its failure threshold.', { ...evidence })
  if (evidence.oldestDueAgeSeconds !== null && evidence.oldestDueAgeSeconds >= options.warnAfterSeconds)
    return warn('Due queue work exceeded its warning threshold.', { ...evidence })
  return pass({ ...evidence })
}

async function collectQueue(context: CheckContext, options: QueueCheckOptions): Promise<QueueEvidence | undefined> {
  const env = context.event ? resolveCloudflareBindings<Record<string, unknown>>(context.event) : undefined
  const db = env?.[options.d1Binding] as { prepare?: (sql: string) => { all: () => Promise<unknown> } } | undefined
  if (typeof db?.prepare !== 'function')
    return undefined
  const response = await db.prepare(backpressureSql()).all()
  if (!response || typeof response !== 'object' || !('results' in response) || !Array.isArray(response.results) || ('success' in response && response.success === false))
    throw new Error('Queue query returned invalid data.')
  const raw = response.results.find((row: unknown) => row !== null && typeof row === 'object' && 'queue' in row && row.queue === options.queue)
  if (raw === undefined)
    return { queue: options.queue, ready: 0, reserved: 0, delayed: 0, oldestDueAgeSeconds: null, oldestReservationAgeSeconds: null }
  const row = raw as Record<string, unknown>
  const count = (key: string) => {
    const value = row[key]
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      throw new Error('Queue count is invalid.')
    return value
  }
  const age = (key: string) => {
    const value = row[key]
    if (value === null)
      return null
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new Error('Queue timestamp is invalid.')
    return Math.max(0, context.now.getTime() / 1000 - value)
  }
  const ready = count('ready')
  const reserved = count('reserved')
  const oldestDueAgeSeconds = age('oldest_available_at')
  const oldestReservationAgeSeconds = age('oldest_reserved_at')
  if ((ready > 0) !== (oldestDueAgeSeconds !== null) || (reserved > 0) !== (oldestReservationAgeSeconds !== null))
    throw new Error('Queue counts and timestamps disagree.')
  return { queue: options.queue, ready, reserved, delayed: count('delayed'), oldestDueAgeSeconds, oldestReservationAgeSeconds }
}

export function defineQueueCheck(options: QueueCheckOptions): Check {
  for (const value of [options.warnAfterSeconds, options.failAfterSeconds, options.staleAfterSeconds ?? 1]) {
    if (!Number.isFinite(value) || value <= 0)
      throw new TypeError('Queue thresholds must be positive seconds.')
  }
  if (options.warnAfterSeconds > options.failAfterSeconds)
    throw new TypeError('Queue warning threshold must not exceed its failure threshold.')
  if (!options.queue?.trim() || !options.d1Binding?.trim())
    throw new TypeError('Queue check requires a queue and D1 binding.')
  return defineCheck({
    id: options.id,
    async run(context) {
      const evidence = await collectQueue(context, options)
      return evidence ? evaluateQueueCheck(evidence, options) : unavailable('Queue D1 binding is unavailable.')
    },
  })
}

export default defineQueueCheck
