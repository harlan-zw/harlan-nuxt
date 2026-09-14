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
  failMinimumReady?: number
  staleAfterSeconds?: number
}

export interface QueueEvidence {
  queue: string
  ready: number
  reserved: number
  delayed: number
  oldestDueAgeSeconds: number | null
  oldestReservationAgeSeconds: number | null
}

export function evaluateQueueCheck(evidence: QueueEvidence, options: Pick<QueueCheckOptions, 'warnAfterSeconds' | 'failAfterSeconds' | 'staleAfterSeconds' | 'failMinimumReady'>) {
  if (evidence.oldestReservationAgeSeconds !== null && options.staleAfterSeconds !== undefined && evidence.oldestReservationAgeSeconds >= options.staleAfterSeconds)
    return fail('Queue has a stale reservation.', { ...evidence })
  if (evidence.oldestDueAgeSeconds !== null && evidence.oldestDueAgeSeconds >= options.failAfterSeconds && evidence.ready >= (options.failMinimumReady ?? 1))
    return fail('Due queue work exceeded its failure threshold.', { ...evidence })
  if (evidence.oldestDueAgeSeconds !== null && evidence.oldestDueAgeSeconds >= options.warnAfterSeconds)
    return warn('Due queue work exceeded its warning threshold.', { ...evidence })
  return pass({ ...evidence })
}

export async function collectQueueEvidence(context: CheckContext, binding: string): Promise<readonly QueueEvidence[] | undefined> {
  const env = context.event ? resolveCloudflareBindings<Record<string, unknown>>(context.event) : undefined
  const db = env?.[binding] as { prepare?: (sql: string) => { all: () => Promise<unknown> } } | undefined
  if (typeof db?.prepare !== 'function')
    return undefined
  const prepare = db.prepare.bind(db)
  return context.collect(db, 'cf-jobs.backpressure', async () => {
    const response = await prepare(backpressureSql(undefined, context.now.getTime() / 1000)).all()
    if (!response || typeof response !== 'object' || !('results' in response) || !Array.isArray(response.results) || ('success' in response && response.success === false))
      throw new Error('Queue query returned invalid data.')
    const rows = response.results.map(raw => parseQueueEvidence(raw, context.now.getTime() / 1000))
    if (new Set(rows.map(row => row.queue)).size !== rows.length)
      throw new Error('Queue query returned duplicate queues.')
    const meta = 'meta' in response ? response.meta as { rows_read?: number } | undefined : undefined
    return { value: rows, metrics: { requests: 1, ...(meta?.rows_read === undefined ? {} : { rowsRead: meta.rows_read }) } }
  })
}

function parseQueueEvidence(raw: unknown, nowSeconds: number): QueueEvidence {
  if (!raw || typeof raw !== 'object' || !('queue' in raw) || typeof raw.queue !== 'string' || !raw.queue.trim())
    throw new Error('Queue query returned an invalid queue.')
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
    return Math.max(0, nowSeconds - value)
  }
  const ready = count('ready')
  const reserved = count('reserved')
  const oldestDueAgeSeconds = age('oldest_available_at')
  const oldestReservationAgeSeconds = age('oldest_reserved_at')
  if ((ready > 0) !== (oldestDueAgeSeconds !== null) || (reserved > 0) !== (oldestReservationAgeSeconds !== null))
    throw new Error('Queue counts and timestamps disagree.')
  return { queue: raw.queue, ready, reserved, delayed: count('delayed'), oldestDueAgeSeconds, oldestReservationAgeSeconds }
}

export function defineQueueCheck(options: QueueCheckOptions): Check {
  for (const value of [options.warnAfterSeconds, options.failAfterSeconds, options.staleAfterSeconds ?? 1]) {
    if (!Number.isFinite(value) || value <= 0)
      throw new TypeError('Queue thresholds must be positive seconds.')
  }
  if (options.failMinimumReady !== undefined && (!Number.isSafeInteger(options.failMinimumReady) || options.failMinimumReady < 1))
    throw new TypeError('Queue failure volume must be a positive integer.')
  if (options.warnAfterSeconds > options.failAfterSeconds)
    throw new TypeError('Queue warning threshold must not exceed its failure threshold.')
  if (!options.queue?.trim() || !options.d1Binding?.trim())
    throw new TypeError('Queue check requires a queue and D1 binding.')
  return defineCheck({
    id: options.id,
    async run(context) {
      const rows = await collectQueueEvidence(context, options.d1Binding)
      if (!rows)
        return unavailable('Queue D1 binding is unavailable.')
      const evidence = rows.find(row => row.queue === options.queue)
        ?? { queue: options.queue, ready: 0, reserved: 0, delayed: 0, oldestDueAgeSeconds: null, oldestReservationAgeSeconds: null }
      return evaluateQueueCheck(evidence, options)
    },
  })
}

export default defineQueueCheck
