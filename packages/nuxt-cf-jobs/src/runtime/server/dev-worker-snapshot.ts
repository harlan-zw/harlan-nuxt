import type { D1DatabaseLike, D1PreparedStatementLike } from './d1'

/**
 * Read-only D1 snapshots powering the `cf-jobs work` live dashboard. Kept apart
 * from the durable repository (which mutates) so the dashboard can never claim or
 * change a job — it only counts and lists. Defaults to the canonical table names.
 */

export interface DurableSnapshotTables {
  jobs?: string
  failedJobs?: string
}

export interface DurableQueueSnapshot {
  queue: string
  /** Unreserved and due. */
  ready: number
  /** Claimed and in-flight. */
  reserved: number
  /** Unreserved but scheduled for later. */
  delayed: number
  /** Finished successfully (still in `jobs` until pruned). */
  completed: number
  /** Moved to `failed_jobs`. */
  failed: number
}

export interface DurableJobOutcome {
  id: string
  type: string
  queue: string
  outcome: 'completed' | 'failed'
  durationMs: number | null
  error: string | null
  /** Unix seconds the job reached its terminal state. */
  at: number
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0)
}

async function all<T>(statement: D1PreparedStatementLike<T>): Promise<T[]> {
  const result = await statement.all?.<T>()
  return result?.results ?? []
}

/** Per-queue ready/reserved/delayed/completed (from `jobs`) merged with failed counts (from `failed_jobs`). */
export async function snapshotDurableQueues(
  db: D1DatabaseLike,
  tables: DurableSnapshotTables = {},
  now: number = Math.floor(Date.now() / 1000),
): Promise<DurableQueueSnapshot[]> {
  const jobsTable = tables.jobs ?? 'jobs'
  const failedTable = tables.failedJobs ?? 'failed_jobs'

  const activeStatement = db.prepare<{ queue: string, ready: number, reserved: number, delayed: number, completed: number }>(`
      SELECT queue,
        SUM(CASE WHEN reserved_at IS NULL AND available_at <= ? AND completed_at IS NULL THEN 1 ELSE 0 END) AS ready,
        SUM(CASE WHEN reserved_at IS NOT NULL AND completed_at IS NULL THEN 1 ELSE 0 END) AS reserved,
        SUM(CASE WHEN reserved_at IS NULL AND available_at > ? AND completed_at IS NULL THEN 1 ELSE 0 END) AS delayed,
        SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed
      FROM ${jobsTable}
      GROUP BY queue
    `).bind(now, now)
  const failedStatement = db.prepare<{ queue: string, failed: number }>(
    `SELECT queue, COUNT(*) AS failed FROM ${failedTable} GROUP BY queue`,
  )
  const [active, failed] = typeof db.batch === 'function'
    ? await db.batch([activeStatement, failedStatement]).then(results => [
        (results[0]?.results ?? []) as Array<{ queue: string, ready: number, reserved: number, delayed: number, completed: number }>,
        (results[1]?.results ?? []) as Array<{ queue: string, failed: number }>,
      ] as const)
    : await Promise.all([
        all(activeStatement),
        all(failedStatement),
      ])

  const byQueue = new Map<string, DurableQueueSnapshot>()
  for (const r of active)
    byQueue.set(r.queue, { queue: r.queue, ready: num(r.ready), reserved: num(r.reserved), delayed: num(r.delayed), completed: num(r.completed), failed: 0 })
  for (const r of failed) {
    const existing = byQueue.get(r.queue) ?? { queue: r.queue, ready: 0, reserved: 0, delayed: 0, completed: 0, failed: 0 }
    existing.failed = num(r.failed)
    byQueue.set(r.queue, existing)
  }
  return [...byQueue.values()].sort((a, b) => a.queue.localeCompare(b.queue))
}

export interface RecentTerminalJobsQuery {
  limit?: number
  /** Only jobs that reached a terminal state at-or-after this unix second (event-stream cursor). */
  sinceSeconds?: number
}

/** Most-recently terminal jobs (completed + failed), newest first. */
export async function recentTerminalJobs(
  db: D1DatabaseLike,
  query: RecentTerminalJobsQuery = {},
  tables: DurableSnapshotTables = {},
): Promise<DurableJobOutcome[]> {
  const jobsTable = tables.jobs ?? 'jobs'
  const failedTable = tables.failedJobs ?? 'failed_jobs'
  const limit = Math.max(1, query.limit ?? 12)
  const since = query.sinceSeconds ?? 0
  const rows = await all<{ id: string, type: string, queue: string, durationMs: number | null, at: number, error: string | null, outcome: 'completed' | 'failed' }>(
    db.prepare(`
      SELECT id, job_type AS type, queue, duration_ms AS durationMs, completed_at AS at, NULL AS error, 'completed' AS outcome
      FROM ${jobsTable} WHERE completed_at IS NOT NULL AND completed_at >= ?
      UNION ALL
      SELECT id, job_type AS type, queue, NULL AS durationMs, failed_at AS at, exception AS error, 'failed' AS outcome
      FROM ${failedTable} WHERE failed_at >= ?
      ORDER BY at DESC
      LIMIT ?
    `).bind(since, since, limit),
  )
  return rows.map(r => ({
    id: r.id,
    type: r.type,
    queue: r.queue,
    outcome: r.outcome,
    durationMs: r.durationMs ?? null,
    error: r.error ?? null,
    at: num(r.at),
  }))
}
