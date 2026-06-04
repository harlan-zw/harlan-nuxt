import type {
  DurableJobFailureRepository,
  DurableJobLifecycle,
  DurableJobPruneRepository,
  DurableJobRecord,
  DurableJobRecoveryRepository,
  DurableJobRepository,
  ReleaseDurableJobOptions,
} from './outbox'

export interface D1PreparedStatementLike<T = unknown> {
  bind: (...values: unknown[]) => D1PreparedStatementLike<T>
  run: () => Promise<{ success?: boolean, meta?: { changes?: number } }>
  first: <Result = T>() => Promise<Result | null>
  all?: <Result = T>() => Promise<{ results?: Result[] }>
}

export interface D1DatabaseLike {
  exec: (query: string) => Promise<unknown>
  prepare: <T = unknown>(query: string) => D1PreparedStatementLike<T>
  /** Optional batch API matching `D1Database.batch`. When absent, batched ops fall back to sequential `.run()`. */
  batch?: (statements: D1PreparedStatementLike<unknown>[]) => Promise<Array<{ success?: boolean, meta?: { changes?: number } }>>
}

export interface D1DurableJobRecord<Queue extends string = string> {
  id: string
  queue: Queue
  job_type: string
  batch_id: string | null
  user_id: number | null
  site_id: string | null
  partner_id: string | null
  trace_id: string | null
  unique_key: string | null
  payload: string
  attempts: number
  max_attempts: number
  reserved_at: number | null
  available_at: number
  created_at: number
  completed_at: number | null
  failed_at: number | null
  last_error: string | null
  retry_reasons?: string | null
  rows_fetched?: number | null
  rows_inserted?: number | null
  d1_rows_read?: number | null
  d1_rows_written?: number | null
  duration_ms?: number | null
}

export interface D1FailedDurableJobRecord<Queue extends string = string> {
  id: string
  queue: Queue
  job_type: string
  batch_id: string | null
  user_id: number | null
  site_id: string | null
  partner_id: string | null
  trace_id: string | null
  unique_key: string | null
  payload: string
  exception: string
  attempts: number
  max_attempts: number
  failed_at: number
}

export interface D1DurableJobRepositoryOptions<Queue extends string = string> {
  jobsTable?: string
  failedJobsTable?: string
  batchesTable?: string
  /**
   * Laravel's `retry_after`: when set, `claimJob` also reclaims a reservation
   * older than this many seconds (a dead worker that never acked/released), in
   * one atomic statement — so a redelivered message re-runs instead of bouncing
   * until DLQ. MUST be longer than the slowest job, or a still-running job can be
   * double-claimed. Default unset = only unreserved rows are claimable.
   */
  reclaimAfterSeconds?: number
  /** Fire-and-forget hook invoked after a successful claim. Errors are swallowed. */
  onJobClaimed?: (input: { job: D1DurableJobRecord<Queue> }) => void
  /** Fire-and-forget hook invoked after `completeJob` writes succeed. Errors are swallowed. */
  onJobCompleted?: (input: { job: D1DurableJobRecord<Queue>, durationMs: number | null, result?: unknown }) => void
  /** Fire-and-forget hook invoked after `failJob` writes succeed. Errors are swallowed. */
  onJobFailed?: (input: { job: D1DurableJobRecord<Queue>, error: string }) => void
  /** Fire-and-forget hook invoked after `releaseJob` writes succeed. Errors are swallowed. */
  onJobReleased?: (input: { job: D1DurableJobRecord<Queue>, opts: ReleaseDurableJobOptions | undefined }) => void
}

export interface D1InsertJobsChunkResult {
  ok: boolean
  ids: string[]
  changes: number
  error?: unknown
}

export interface D1InsertJobsResult<Queue extends string = string> {
  inserted: Array<DurableJobRecord<Queue>>
  chunks: D1InsertJobsChunkResult[]
}

export type D1DurableJobRepository<Queue extends string = string>
  = DurableJobRepository<Queue, DurableJobRecord<Queue>>
    & DurableJobRecoveryRepository<Queue, D1DurableJobRecord<Queue>>
    & DurableJobLifecycle<D1DurableJobRecord<Queue>>
    & DurableJobFailureRepository
    & DurableJobPruneRepository
    & {
      migrate: () => Promise<void>
      insertJobs: (
        records: readonly DurableJobRecord<Queue>[],
        opts?: { batchSize?: number },
      ) => Promise<D1InsertJobsResult<Queue>>
      toDispatchableJob: (job: D1DurableJobRecord<Queue>) => {
        id: string
        queue: Queue
        payload: Record<string, unknown>
        attempts: number
        batchId: string | null
        siteId: string | null
        userId: number | null
      }
    }

export const d1DurableJobMigrationSql = [
  'CREATE TABLE IF NOT EXISTS job_batches (id text PRIMARY KEY, name text, parent_batch_id text, total_jobs integer NOT NULL DEFAULT 0, pending_jobs integer NOT NULL DEFAULT 0, failed_jobs integer NOT NULL DEFAULT 0, on_finish text, handler text, allow_failures integer DEFAULT 0, site_id text, user_id integer, created_at integer NOT NULL DEFAULT (unixepoch()), updated_at integer NOT NULL DEFAULT (unixepoch()), finished_at integer)',
  'CREATE TABLE IF NOT EXISTS jobs (id text PRIMARY KEY, queue text NOT NULL, job_type text NOT NULL, batch_id text REFERENCES job_batches(id), user_id integer, site_id text, partner_id text, trace_id text, unique_key text, payload text NOT NULL, attempts integer DEFAULT 0, max_attempts integer DEFAULT 3, reserved_at integer, available_at integer NOT NULL, created_at integer NOT NULL DEFAULT (unixepoch()), completed_at integer, failed_at integer, last_error text, retry_reasons text, rows_fetched integer, rows_inserted integer, d1_rows_read integer, d1_rows_written integer, duration_ms integer)',
  'CREATE TABLE IF NOT EXISTS failed_jobs (id text PRIMARY KEY, queue text NOT NULL, job_type text NOT NULL, batch_id text, user_id integer, site_id text, partner_id text, trace_id text, unique_key text, payload text NOT NULL, exception text NOT NULL, attempts integer NOT NULL, max_attempts integer NOT NULL, failed_at integer NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_job_batches_site ON job_batches (site_id)',
  'CREATE INDEX IF NOT EXISTS idx_job_batches_pending ON job_batches (pending_jobs)',
  'CREATE INDEX IF NOT EXISTS idx_job_batches_parent ON job_batches (parent_batch_id)',
  'CREATE INDEX IF NOT EXISTS idx_job_batches_finished_at ON job_batches (finished_at)',
  'CREATE INDEX IF NOT EXISTS idx_jobs_claimable ON jobs (queue, reserved_at, available_at)',
  'CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs (user_id)',
  'CREATE INDEX IF NOT EXISTS idx_jobs_site ON jobs (site_id)',
  'CREATE INDEX IF NOT EXISTS idx_jobs_partner ON jobs (partner_id)',
  'CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs (job_type)',
  'CREATE INDEX IF NOT EXISTS idx_jobs_batch ON jobs (batch_id)',
  'CREATE INDEX IF NOT EXISTS idx_jobs_trace ON jobs (trace_id)',
  'CREATE INDEX IF NOT EXISTS idx_jobs_sync_dedup ON jobs (site_id, job_type)',
  // Partial index backing pruneCompletedJobs (completed_at IS NOT NULL AND <= ?).
  'CREATE INDEX IF NOT EXISTS idx_jobs_completed_at ON jobs (completed_at) WHERE completed_at IS NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_unique_active ON jobs (unique_key) WHERE unique_key IS NOT NULL AND completed_at IS NULL AND failed_at IS NULL',
  'CREATE INDEX IF NOT EXISTS idx_failed_jobs_queue ON failed_jobs (queue)',
  'CREATE INDEX IF NOT EXISTS idx_failed_jobs_site ON failed_jobs (site_id)',
  'CREATE INDEX IF NOT EXISTS idx_failed_jobs_trace ON failed_jobs (trace_id)',
  'CREATE INDEX IF NOT EXISTS idx_failed_jobs_failed_at ON failed_jobs (failed_at)',
]

export function createD1DurableJobRepository<Queue extends string = string>(
  db: D1DatabaseLike,
  opts: D1DurableJobRepositoryOptions<Queue> = {},
): D1DurableJobRepository<Queue> {
  const jobsTable = opts.jobsTable ?? 'jobs'
  const failedJobsTable = opts.failedJobsTable ?? 'failed_jobs'
  const batchesTable = opts.batchesTable ?? 'job_batches'

  const insertJobSql = `
    INSERT OR IGNORE INTO ${jobsTable} (
      id, queue, job_type, batch_id, user_id, site_id, partner_id, trace_id, unique_key, payload,
      attempts, max_attempts, available_at, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `

  function bindInsertJob(record: DurableJobRecord<Queue>): D1PreparedStatementLike<unknown> {
    return db.prepare(insertJobSql).bind(
      record.id,
      record.queue,
      record.jobType,
      record.batchId ?? null,
      record.userId ?? null,
      record.siteId ?? null,
      record.partnerId ?? null,
      record.traceId,
      record.uniqueKey ?? null,
      record.payload,
      record.attempts,
      record.maxAttempts,
      record.availableAt,
      record.createdAt,
    )
  }

  return {
    async migrate() {
      for (const statement of d1DurableJobMigrationSql)
        await db.exec(statement)
    },

    async insertJob(record) {
      const result = await bindInsertJob(record).run()
      return typeof result.meta?.changes === 'number'
        ? result.meta.changes > 0
        : result.success === true
    },

    async insertJobs(records, insertOpts) {
      if (records.length === 0)
        return { inserted: [], chunks: [] }

      const batchSize = Math.max(1, Math.min(insertOpts?.batchSize ?? 90, 100))
      const chunks: D1InsertJobsChunkResult[] = []
      const inserted: Array<DurableJobRecord<Queue>> = []

      for (let i = 0; i < records.length; i += batchSize) {
        const slice = records.slice(i, i + batchSize)
        const stmts = slice.map(bindInsertJob)
        try {
          const results = typeof db.batch === 'function'
            ? await db.batch(stmts)
            : await Promise.all(stmts.map(s => s.run()))
          const changes = results.reduce((sum, r) => sum + (r.meta?.changes ?? (r.success ? 1 : 0)), 0)
          chunks.push({ ok: true, ids: slice.map(r => r.id), changes })
          // Best-effort: when batch is atomic we trust `changes`; per-row attribution isn't possible
          // with INSERT OR IGNORE so we report all slice records as inserted only when `changes === slice.length`.
          if (changes === slice.length) {
            inserted.push(...slice)
          }
          else if (changes > 0 && typeof db.batch !== 'function') {
            // sequential path returns per-statement meta — we can attribute precisely
            for (let j = 0; j < slice.length; j++) {
              if ((results[j]?.meta?.changes ?? 0) > 0)
                inserted.push(slice[j]!)
            }
          }
        }
        catch (error) {
          chunks.push({ ok: false, ids: slice.map(r => r.id), changes: 0, error })
        }
      }

      if (chunks.length > 0 && chunks.every(c => !c.ok))
        throw chunks[0]!.error ?? new Error('All insertJobs chunks failed')

      return { inserted, chunks }
    },

    async claimJob(id) {
      const now = currentUnixSeconds()
      // `reclaimBefore`: reservations at or before this are treated as abandoned
      // (Laravel `retry_after`). Unset → -1, which no real (positive) reserved_at
      // satisfies, so only unreserved rows are claimable (prior behaviour).
      const reclaimBefore = typeof opts.reclaimAfterSeconds === 'number' ? now - opts.reclaimAfterSeconds : -1
      const job = await db.prepare<D1DurableJobRecord<Queue>>(`
        UPDATE ${jobsTable}
        SET reserved_at = ?, attempts = attempts + 1
        WHERE id = ?
          AND (reserved_at IS NULL OR reserved_at <= ?)
          AND available_at <= ?
          AND completed_at IS NULL
          AND failed_at IS NULL
        RETURNING *
      `).bind(now, id, reclaimBefore, now).first<D1DurableJobRecord<Queue>>()
      if (job)
        fireHook(() => opts.onJobClaimed?.({ job }))
      return job
    },

    async resolveClaimMiss(id) {
      const job = await db.prepare<Pick<D1DurableJobRecord<Queue>, 'reserved_at' | 'completed_at' | 'failed_at'>>(`
        SELECT reserved_at, completed_at, failed_at
        FROM ${jobsTable}
        WHERE id = ?
      `).bind(id).first<Pick<D1DurableJobRecord<Queue>, 'reserved_at' | 'completed_at' | 'failed_at'>>()
      if (!job)
        return 'not-found'
      if (job.completed_at || job.failed_at)
        return 'already-resolved'
      return 'in-flight'
    },

    async completeJob(job, result) {
      const stats = readResultStat(result)
      // Reported durationMs wins; else derive from the reservation (Laravel-style
      // wall-clock) so duration is populated even when the handler reports none.
      const reportedDuration = stats('durationMs')
      const durationMs = reportedDuration ?? (job.reserved_at != null ? (currentUnixSeconds() - job.reserved_at) * 1000 : null)
      await db.prepare(`
        UPDATE ${jobsTable}
        SET completed_at = unixepoch(), reserved_at = NULL,
            duration_ms = COALESCE(?, duration_ms),
            rows_fetched = COALESCE(?, rows_fetched),
            rows_inserted = COALESCE(?, rows_inserted),
            d1_rows_read = COALESCE(?, d1_rows_read),
            d1_rows_written = COALESCE(?, d1_rows_written)
        WHERE id = ?
      `).bind(
        durationMs,
        stats('rowsFetched') ?? null,
        stats('rowsInserted') ?? null,
        stats('d1RowsRead') ?? null,
        stats('d1RowsWritten') ?? null,
        job.id,
      ).run()
      fireHook(() => opts.onJobCompleted?.({ job, durationMs, result }))
    },

    async failJob(job, error) {
      await db.prepare(`
        INSERT OR REPLACE INTO ${failedJobsTable} (
          id, queue, job_type, batch_id, user_id, site_id, partner_id, trace_id, unique_key, payload,
          exception, attempts, max_attempts, failed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `).bind(
        job.id,
        job.queue,
        job.job_type,
        job.batch_id,
        job.user_id,
        job.site_id,
        job.partner_id,
        job.trace_id,
        job.unique_key,
        job.payload,
        error,
        job.attempts,
        job.max_attempts,
      ).run()
      await db.prepare(`DELETE FROM ${jobsTable} WHERE id = ?`).bind(job.id).run()
      fireHook(() => opts.onJobFailed?.({ job, error }))
    },

    async releaseJob(job, releaseOpts) {
      await db.prepare(`
        UPDATE ${jobsTable}
        SET reserved_at = NULL, available_at = ?, last_error = COALESCE(?, last_error)
        WHERE id = ?
      `).bind(resolveAvailableAt(releaseOpts), releaseOpts?.error ?? null, job.id).run()
      fireHook(() => opts.onJobReleased?.({ job, opts: releaseOpts }))
    },

    async recordFailure(input) {
      await db.prepare(`
        INSERT OR REPLACE INTO ${failedJobsTable} (
          id, queue, job_type, batch_id, user_id, site_id, partner_id, trace_id, unique_key, payload,
          exception, attempts, max_attempts, failed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `).bind(
        input.id ?? crypto.randomUUID(),
        input.queue,
        input.jobType,
        input.batchId ?? null,
        input.userId ?? null,
        input.siteId ?? null,
        input.partnerId ?? null,
        input.traceId ?? null,
        input.uniqueKey ?? null,
        input.payload,
        input.exception,
        input.attempts,
        input.maxAttempts ?? input.attempts,
      ).run()
    },

    async findDispatchableJobs(query = {}) {
      return await all<D1DurableJobRecord<Queue>>(db.prepare(`
        SELECT *
        FROM ${jobsTable}
        WHERE reserved_at IS NULL
          AND available_at <= ?
          AND completed_at IS NULL
          AND failed_at IS NULL
        ORDER BY available_at ASC
        LIMIT ?
      `).bind(query.now ?? currentUnixSeconds(), query.limit ?? 100))
    },

    async findStaleReservedJobs(query) {
      return await all<D1DurableJobRecord<Queue>>(db.prepare(`
        SELECT *
        FROM ${jobsTable}
        WHERE reserved_at IS NOT NULL
          AND reserved_at <= ?
          AND completed_at IS NULL
          AND failed_at IS NULL
        ORDER BY reserved_at ASC
        LIMIT ?
      `).bind(query.staleBefore, query.limit ?? 100))
    },

    async releaseStaleReservedJobs(query) {
      const result = await db.prepare(`
        UPDATE ${jobsTable}
        SET reserved_at = NULL, available_at = ?, last_error = COALESCE(?, last_error)
        WHERE id IN (
          SELECT id
          FROM ${jobsTable}
          WHERE reserved_at IS NOT NULL
            AND reserved_at <= ?
            AND completed_at IS NULL
            AND failed_at IS NULL
          LIMIT ?
        )
      `).bind(
        query.availableAt ?? query.now ?? currentUnixSeconds(),
        query.error ?? null,
        query.staleBefore,
        query.limit ?? 100,
      ).run()
      return result.meta?.changes ?? 0
    },

    toDispatchableJob(job) {
      return {
        id: job.id,
        queue: job.queue,
        payload: JSON.parse(job.payload) as Record<string, unknown>,
        attempts: job.attempts,
        batchId: job.batch_id,
        siteId: job.site_id,
        userId: job.user_id,
      }
    },

    async pruneCompletedJobs(query) {
      // Only soft-completed rows (completed_at IS NOT NULL) — never in-flight ones.
      return await pruneInChunks(db, jobsTable, 'completed_at IS NOT NULL AND completed_at <= ?', query)
    },

    async pruneFailedJobs(query) {
      // failed_jobs.failed_at is always set; the predicate is just the age cutoff.
      return await pruneInChunks(db, failedJobsTable, 'failed_at <= ?', query)
    },

    async pruneFinishedBatches(query) {
      // Only terminal batches (finished_at IS NOT NULL), AND only once no `jobs`
      // row still references them — `jobs.batch_id` FKs `job_batches(id)`, so
      // deleting a batch with a lingering (not-yet-pruned) completed member would
      // violate the FK where D1 enforces it. This makes the prune FK-safe even
      // when completed-jobs retention is set LONGER than batch retention; such a
      // batch is simply pruned on a later run once its members age out.
      return await pruneInChunks(
        db,
        batchesTable,
        `finished_at IS NOT NULL AND finished_at <= ? AND NOT EXISTS (SELECT 1 FROM ${jobsTable} WHERE ${jobsTable}.batch_id = ${batchesTable}.id)`,
        query,
      )
    },
  }
}

const DEFAULT_PRUNE_CHUNK = 1000

/**
 * Chunked DELETE so a large backlog never exceeds D1's per-statement row cap.
 * `whereClause` is a SQL predicate ending in a single `?` for the `before` cutoff;
 * it is composed from a fixed table name + fixed literal, never user input. Loops
 * until a chunk deletes fewer than the chunk size, summing the total removed.
 */
async function pruneInChunks(
  db: D1DatabaseLike,
  table: string,
  whereClause: string,
  query: { before: number, limit?: number },
): Promise<number> {
  const chunk = Math.max(1, query.limit ?? DEFAULT_PRUNE_CHUNK)
  const sql = `
    DELETE FROM ${table}
    WHERE id IN (
      SELECT id FROM ${table}
      WHERE ${whereClause}
      LIMIT ?
    )
  `
  let total = 0
  for (;;) {
    const result = await db.prepare(sql).bind(query.before, chunk).run()
    const changes = result.meta?.changes ?? 0
    total += changes
    if (changes < chunk)
      break
  }
  return total
}

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/** Reader for numeric stat fields on a completeJob result (durationMs + JobRunStats). */
function readResultStat(result: unknown): (key: 'durationMs' | 'rowsFetched' | 'rowsInserted' | 'd1RowsRead' | 'd1RowsWritten') => number | undefined {
  const obj = result && typeof result === 'object' ? result as Record<string, unknown> : undefined
  return (key) => {
    const v = obj?.[key]
    return typeof v === 'number' ? v : undefined
  }
}

function fireHook(fn: () => void | Promise<void>): void {
  try {
    const result = fn()
    if (result && typeof (result as Promise<unknown>).then === 'function')
      (result as Promise<unknown>).catch(() => {})
  }
  catch {
    // hooks are fire-and-forget
  }
}

function resolveAvailableAt(opts: ReleaseDurableJobOptions | undefined): number {
  if (typeof opts?.availableAt === 'number')
    return opts.availableAt
  return currentUnixSeconds() + (opts?.delaySeconds ?? 0)
}

async function all<T>(statement: D1PreparedStatementLike<T>): Promise<T[]> {
  const result = await statement.all?.<T>()
  return result?.results ?? []
}
