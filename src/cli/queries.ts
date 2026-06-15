/**
 * Pure SQL builders + row aggregation for the `cf-jobs` CLI. Kept free of any
 * I/O so the query shapes and the backpressure math are unit-testable without a
 * live D1 / wrangler subprocess.
 *
 * `wrangler d1 execute --command` takes literal SQL with no bind-parameter
 * channel, so user-supplied values are inlined through `sqlString` / `sqlInt`
 * which escape against injection. `unixepoch()` is used for "now" so the
 * database clock — not the CLI host — defines readiness.
 */

export interface TableNames {
  jobs: string
  failed: string
  batches: string
}

export const defaultTableNames: TableNames = {
  jobs: 'jobs',
  failed: 'failed_jobs',
  batches: 'job_batches',
}

export type JobState = 'ready' | 'reserved' | 'delayed' | 'completed'

export function sqlString(value: string): string {
  return `'${value.replace(/'/g, '\'\'')}'`
}

export function sqlInt(value: number): number {
  if (!Number.isFinite(value))
    throw new TypeError(`Expected a finite number, got ${value}`)
  return Math.trunc(value)
}

/** SQL predicate selecting only live (not completed, not failed) rows. */
const ACTIVE = 'completed_at IS NULL AND failed_at IS NULL'

function stateClause(state: JobState | undefined): string {
  switch (state) {
    case 'ready':
      return 'reserved_at IS NULL AND available_at <= unixepoch()'
    case 'reserved':
      return 'reserved_at IS NOT NULL'
    case 'delayed':
      return 'reserved_at IS NULL AND available_at > unixepoch()'
    case 'completed':
      return 'completed_at IS NOT NULL'
    default:
      return ''
  }
}

function andClauses(...clauses: Array<string | false | undefined>): string {
  const parts = clauses.filter((c): c is string => !!c)
  return parts.length ? `WHERE ${parts.join(' AND ')}` : ''
}

export interface BackpressureRow {
  queue: string
  total: number
  ready: number
  reserved: number
  delayed: number
  oldest_available_at: number | null
  oldest_reserved_at: number | null
}

/** One row per queue: live counts split by state plus the oldest timestamps. */
export function backpressureSql(t: TableNames = defaultTableNames): string {
  return `SELECT queue,
  COUNT(*) AS total,
  SUM(CASE WHEN reserved_at IS NULL AND available_at <= unixepoch() THEN 1 ELSE 0 END) AS ready,
  SUM(CASE WHEN reserved_at IS NOT NULL THEN 1 ELSE 0 END) AS reserved,
  SUM(CASE WHEN reserved_at IS NULL AND available_at > unixepoch() THEN 1 ELSE 0 END) AS delayed,
  MIN(CASE WHEN reserved_at IS NULL AND available_at <= unixepoch() THEN available_at END) AS oldest_available_at,
  MIN(reserved_at) AS oldest_reserved_at
FROM ${t.jobs}
WHERE ${ACTIVE}
GROUP BY queue
ORDER BY total DESC`
}

export interface JobTypeRow {
  job_type: string
  queue: string
  total: number
}

export function jobTypeBreakdownSql(t: TableNames = defaultTableNames): string {
  return `SELECT job_type, queue, COUNT(*) AS total
FROM ${t.jobs}
WHERE ${ACTIVE}
GROUP BY job_type, queue
ORDER BY total DESC`
}

export function failedCountSql(t: TableNames = defaultTableNames): string {
  return `SELECT queue, COUNT(*) AS total FROM ${t.failed} GROUP BY queue ORDER BY total DESC`
}

/** Reserved (in-flight) rows whose claim is older than `staleSeconds`. */
export function staleReservedSql(staleSeconds: number, t: TableNames = defaultTableNames): string {
  return `SELECT COUNT(*) AS total
FROM ${t.jobs}
WHERE reserved_at IS NOT NULL AND reserved_at <= unixepoch() - ${sqlInt(staleSeconds)} AND ${ACTIVE}`
}

export interface ListFilters {
  queue?: string
  type?: string
  state?: JobState
  limit?: number
}

export function activeJobsSql(filters: ListFilters = {}, t: TableNames = defaultTableNames): string {
  const limit = sqlInt(filters.limit ?? 50)
  return `SELECT id, queue, job_type, attempts, max_attempts, available_at, reserved_at, created_at, site_id, last_error
FROM ${t.jobs}
${andClauses(
  ACTIVE,
  filters.queue && `queue = ${sqlString(filters.queue)}`,
  filters.type && `job_type = ${sqlString(filters.type)}`,
  stateClause(filters.state),
)}
ORDER BY available_at ASC
LIMIT ${limit}`
}

export function failedJobsSql(filters: ListFilters = {}, t: TableNames = defaultTableNames): string {
  const limit = sqlInt(filters.limit ?? 50)
  return `SELECT id, queue, job_type, attempts, max_attempts, failed_at, site_id, exception
FROM ${t.failed}
${andClauses(
  filters.queue && `queue = ${sqlString(filters.queue)}`,
  filters.type && `job_type = ${sqlString(filters.type)}`,
)}
ORDER BY failed_at DESC
LIMIT ${limit}`
}

/** Columns carried verbatim from a failed row back to the active row. */
const CARRIED_COLUMNS = 'id, queue, job_type, batch_id, user_id, site_id, partner_id, trace_id, unique_key, payload'

/**
 * Move failed rows back into the active table with attempts reset and
 * availability set to now. `INSERT OR IGNORE` so a re-queued id (already active)
 * is left untouched; the DELETE always clears the failed record.
 *
 * NOTE: this only restores the `jobs` row — it does NOT dispatch a queue
 * message, so under the dispatch-on-enqueue model the restored job won't re-run
 * until something sends its `{ jobId, queue }` message. For a runtime "try
 * again" that actually re-runs, use `redispatchFailedJob` (server/retry.ts),
 * which reconstructs a fresh durable job from the stored `_task` envelope.
 */
export function retrySql(opts: { id?: string, queue?: string, all?: boolean }, t: TableNames = defaultTableNames): string {
  if (!opts.id && !opts.queue && !opts.all)
    throw new Error('retrySql requires an id, a queue, or all=true')
  const where = andClauses(
    opts.id && `id = ${sqlString(opts.id)}`,
    opts.queue && `queue = ${sqlString(opts.queue)}`,
  )
  return `INSERT OR IGNORE INTO ${t.jobs} (${CARRIED_COLUMNS}, attempts, max_attempts, available_at, created_at)
SELECT ${CARRIED_COLUMNS}, 0, max_attempts, unixepoch(), unixepoch() FROM ${t.failed} ${where};
DELETE FROM ${t.failed} ${where};`
}

export function forgetSql(id: string, t: TableNames = defaultTableNames): string {
  return `DELETE FROM ${t.failed} WHERE id = ${sqlString(id)}`
}

export function flushSql(queue: string | undefined, t: TableNames = defaultTableNames): string {
  return `DELETE FROM ${t.failed} ${queue ? `WHERE queue = ${sqlString(queue)}` : ''}`.trimEnd()
}

/** Delete soft-completed jobs older than `hours` (artisan-style retention prune). */
export function pruneCompletedJobsSql(hours: number, t: TableNames = defaultTableNames): string {
  return `DELETE FROM ${t.jobs} WHERE completed_at IS NOT NULL AND completed_at <= unixepoch() - ${sqlInt(hours * 3600)}`
}

/** Delete failed jobs older than `hours` (artisan queue:prune-failed --hours). */
export function pruneFailedJobsSql(hours: number, t: TableNames = defaultTableNames): string {
  return `DELETE FROM ${t.failed} WHERE failed_at <= unixepoch() - ${sqlInt(hours * 3600)}`
}

/** Delete finished batches older than `hours` (artisan queue:prune-batches --hours). */
export function pruneFinishedBatchesSql(hours: number, t: TableNames = defaultTableNames): string {
  return `DELETE FROM ${t.batches} WHERE finished_at IS NOT NULL AND finished_at <= unixepoch() - ${sqlInt(hours * 3600)}`
}

/**
 * Combined retention prune across all three tables. Member jobs (completed +
 * failed) are pruned BEFORE finished batches so the `jobs.batch_id` FK can't be
 * violated where D1 enforces it.
 */
export function pruneSql(
  opts: { completedHours: number, failedHours: number, batchesHours: number },
  t: TableNames = defaultTableNames,
): string {
  return [
    pruneCompletedJobsSql(opts.completedHours, t),
    pruneFailedJobsSql(opts.failedHours, t),
    pruneFinishedBatchesSql(opts.batchesHours, t),
  ].join(';\n')
}

/** Delete live (not-yet-completed) jobs, optionally scoped to a queue/state. */
export function clearSql(filters: { queue?: string, state?: JobState } = {}, t: TableNames = defaultTableNames): string {
  return `DELETE FROM ${t.jobs}
${andClauses(
  ACTIVE,
  filters.queue && `queue = ${sqlString(filters.queue)}`,
  stateClause(filters.state),
)}`
}

export interface QueueBackpressure extends BackpressureRow {
  /** Seconds the oldest ready job has waited (now - oldest_available_at), or 0. */
  lagSeconds: number
}

export interface BackpressureSummary {
  queues: QueueBackpressure[]
  totals: { total: number, ready: number, reserved: number, delayed: number }
  /** Worst per-queue lag across all queues, in seconds. */
  maxLagSeconds: number
}

/**
 * Fold raw per-queue rows into a summary with computed ready-lag. `nowSeconds`
 * is passed in (not read from the clock) so the math is deterministic in tests.
 */
export function summarizeBackpressure(rows: readonly BackpressureRow[], nowSeconds: number): BackpressureSummary {
  const queues = rows.map<QueueBackpressure>(r => ({
    ...r,
    lagSeconds: r.oldest_available_at != null && r.ready > 0 ? Math.max(0, nowSeconds - r.oldest_available_at) : 0,
  }))
  const totals = queues.reduce(
    (acc, q) => ({
      total: acc.total + q.total,
      ready: acc.ready + q.ready,
      reserved: acc.reserved + q.reserved,
      delayed: acc.delayed + q.delayed,
    }),
    { total: 0, ready: 0, reserved: 0, delayed: 0 },
  )
  const maxLagSeconds = queues.reduce((max, q) => Math.max(max, q.lagSeconds), 0)
  return { queues, totals, maxLagSeconds }
}
