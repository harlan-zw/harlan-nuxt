import type {
  DurableJobFailureEvidenceRepository,
  DurableJobFailureRepository,
  DurableJobLifecycle,
  DurableJobPruneRepository,
  DurableJobRecord,
  DurableJobRecoveryRepository,
  DurableJobRepository,
  ReleaseDurableJobOptions,
} from './outbox'
import type { Result } from './result'
import { describeCause, DurableJobOwnershipError, headlineOf } from './errors'
import { err, ok } from './result'

export interface D1ResultLike<T = unknown> {
  success?: boolean
  meta?: { changes?: number }
  results?: T[]
}

export interface D1PreparedStatementLike<T = unknown> {
  bind: (...values: unknown[]) => D1PreparedStatementLike<T>
  run: () => Promise<D1ResultLike<T>>
  first: <Result = T>() => Promise<Result | null>
  all?: <Result = T>() => Promise<{ results?: Result[] }>
}

export interface D1DatabaseLike {
  exec: (query: string) => Promise<unknown>
  prepare: <T = unknown>(query: string) => D1PreparedStatementLike<T>
  /** Optional batch API matching `D1Database.batch`. When absent, batched ops fall back to sequential `.run()`. */
  batch?: (statements: D1PreparedStatementLike<unknown>[]) => Promise<Array<D1ResultLike>>
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
  backoff: string | null
  reserved_at: number | null
  available_at: number
  created_at: number
  published_at: number | null
  last_dispatched_at: number | null
  dispatch_attempts: number
  last_dispatch_error: string | null
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
  /** Awaited after a successful claim. Defects are isolated and reported through `onObserverError`. */
  onJobClaimed?: (input: { job: D1DurableJobRecord<Queue> }) => void | Promise<void>
  /** Awaited after `completeJob` writes succeed. Defects are isolated and reported. */
  onJobCompleted?: (input: { job: D1DurableJobRecord<Queue>, durationMs: number | null, result?: unknown }) => void | Promise<void>
  /**
   * Awaited after `failJob` writes succeed. Defects are isolated and reported.
   *
   * `error` is the HEADLINE (`"TypeError: <message>"`) — safe for issue titles,
   * realtime payloads and Analytics Engine blobs. `cause` is the ORIGINAL thrown
   * value: report it as-is (`captureException(cause)`) to keep the native stack.
   */
  onJobFailed?: (input: { job: D1DurableJobRecord<Queue>, error: string, cause?: unknown }) => void | Promise<void>
  /** Awaited after `releaseJob` writes succeed. Defects are isolated and reported. */
  onJobReleased?: (input: { job: D1DurableJobRecord<Queue>, opts: ReleaseDurableJobOptions | undefined }) => void | Promise<void>
  /** Visibility fallback for lifecycle observer defects. Defaults to console.error. */
  onObserverError?: (input: { stage: 'claimed' | 'completed' | 'failed' | 'released', jobId: string, cause: unknown }) => void | Promise<void>
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
    & DurableJobFailureEvidenceRepository
    & DurableJobPruneRepository
    & {
      migrate: () => Promise<void>
      insertJobs: (
        records: readonly DurableJobRecord<Queue>[],
        opts?: { batchSize?: number },
      ) => Promise<D1InsertJobsResult<Queue>>
      prepareStageJobs: (
        records: readonly DurableJobRecord<Queue>[],
      ) => Result<D1PreparedDurableJobStage<Queue>, PrepareD1DurableJobStageError>
      stageJob: (record: DurableJobRecord<Queue>) => Promise<boolean>
      stageJobs: (records: readonly DurableJobRecord<Queue>[]) => Promise<StageD1DurableJobsResult<Queue>>
      markJobsPublished: (ids: readonly string[], opts?: { at?: number }) => Promise<number>
      noteJobsDispatchFailure: (ids: readonly string[], cause: unknown, opts?: { at?: number }) => Promise<number>
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

export interface D1PreparedDurableJobStage<Queue extends string = string> {
  records: readonly DurableJobRecord<Queue>[]
  statements: D1PreparedStatementLike<unknown>[]
}

export type PrepareD1DurableJobStageError
  = | { _tag: 'duplicate-job-id', id: string }

export type StageD1DurableJobsResult<Queue extends string = string>
  = | { status: 'staged', records: readonly DurableJobRecord<Queue>[] }
    | { status: 'invalid', error: PrepareD1DurableJobStageError }
    | { status: 'unsupported', reason: 'transactional-batch-unavailable' }
    | { status: 'failed', cause: unknown }

export const d1DurableJobMigrationSql = [
  'CREATE TABLE IF NOT EXISTS job_batches (id text PRIMARY KEY, name text, parent_batch_id text, total_jobs integer NOT NULL DEFAULT 0, pending_jobs integer NOT NULL DEFAULT 0, failed_jobs integer NOT NULL DEFAULT 0, on_finish text, handler text, allow_failures integer DEFAULT 0, site_id text, user_id integer, created_at integer NOT NULL DEFAULT (unixepoch()), updated_at integer NOT NULL DEFAULT (unixepoch()), finished_at integer)',
  'CREATE TABLE IF NOT EXISTS jobs (id text PRIMARY KEY, queue text NOT NULL, job_type text NOT NULL, batch_id text REFERENCES job_batches(id), user_id integer, site_id text, partner_id text, trace_id text, unique_key text, payload text NOT NULL, attempts integer DEFAULT 0, max_attempts integer DEFAULT 3, backoff text, reserved_at integer, available_at integer NOT NULL, created_at integer NOT NULL DEFAULT (unixepoch()), published_at integer, last_dispatched_at integer, dispatch_attempts integer NOT NULL DEFAULT 0, last_dispatch_error text, completed_at integer, failed_at integer, last_error text, retry_reasons text, rows_fetched integer, rows_inserted integer, d1_rows_read integer, d1_rows_written integer, duration_ms integer)',
  'CREATE TABLE IF NOT EXISTS failed_jobs (id text PRIMARY KEY, queue text NOT NULL, job_type text NOT NULL, batch_id text, user_id integer, site_id text, partner_id text, trace_id text, unique_key text, payload text NOT NULL, exception text NOT NULL, attempts integer NOT NULL, max_attempts integer NOT NULL, failed_at integer NOT NULL)',
  // Drop legacy indexes proven unused by package and downstream query shapes.
  // `pending_jobs` and `reserved_at` are hot lifecycle columns, so indexing them
  // added a write on every batch settlement and claim/release respectively.
  'DROP INDEX IF EXISTS idx_job_batches_pending',
  'DROP INDEX IF EXISTS idx_jobs_claimable',
  'DROP INDEX IF EXISTS idx_jobs_trace',
  'DROP INDEX IF EXISTS idx_failed_jobs_trace',
  'DROP INDEX IF EXISTS idx_failed_jobs_site',
  'DROP INDEX IF EXISTS idx_failed_jobs_batch',
  'CREATE INDEX IF NOT EXISTS idx_job_batches_site ON job_batches (site_id)',
  'CREATE INDEX IF NOT EXISTS idx_job_batches_parent ON job_batches (parent_batch_id)',
  'CREATE INDEX IF NOT EXISTS idx_job_batches_finished_at ON job_batches (finished_at)',
  // Recovery scans are global. Keep these partial indexes bounded to live rows and align
  // their leading columns with the range + ORDER BY used by each recovery query.
  'CREATE INDEX IF NOT EXISTS idx_jobs_dispatchable ON jobs (available_at) WHERE published_at IS NULL AND reserved_at IS NULL AND completed_at IS NULL AND failed_at IS NULL',
  'CREATE INDEX IF NOT EXISTS idx_jobs_stale_reserved ON jobs (reserved_at) WHERE reserved_at IS NOT NULL AND completed_at IS NULL AND failed_at IS NULL',
  'CREATE INDEX IF NOT EXISTS idx_jobs_active ON jobs (created_at) WHERE completed_at IS NULL AND failed_at IS NULL',
  'CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs (user_id)',
  'CREATE INDEX IF NOT EXISTS idx_jobs_site ON jobs (site_id)',
  'CREATE INDEX IF NOT EXISTS idx_jobs_partner ON jobs (partner_id)',
  'CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs (job_type)',
  'CREATE INDEX IF NOT EXISTS idx_jobs_batch ON jobs (batch_id)',
  'CREATE INDEX IF NOT EXISTS idx_jobs_sync_dedup ON jobs (site_id, job_type)',
  // Partial index backing pruneCompletedJobs (completed_at IS NOT NULL AND <= ?).
  'CREATE INDEX IF NOT EXISTS idx_jobs_completed_at ON jobs (completed_at) WHERE completed_at IS NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_unique_active ON jobs (unique_key) WHERE unique_key IS NOT NULL AND completed_at IS NULL AND failed_at IS NULL',
  'CREATE INDEX IF NOT EXISTS idx_failed_jobs_queue ON failed_jobs (queue)',
  'CREATE INDEX IF NOT EXISTS idx_failed_jobs_site_failed_at ON failed_jobs (site_id, failed_at)',
  'CREATE INDEX IF NOT EXISTS idx_failed_jobs_batch_failed_at ON failed_jobs (batch_id, failed_at)',
  'CREATE INDEX IF NOT EXISTS idx_failed_jobs_failed_at ON failed_jobs (failed_at)',
  // Refresh planner statistics after creating indexes. Cloudflare recommends
  // PRAGMA optimize after schema/index changes; migrate() is a maintenance path.
  'PRAGMA optimize',
]

const D1_DURABLE_JOB_PUBLICATION_COLUMNS = [
  { name: 'published_at', definition: 'integer' },
  { name: 'last_dispatched_at', definition: 'integer' },
  { name: 'dispatch_attempts', definition: 'integer NOT NULL DEFAULT 0' },
  { name: 'last_dispatch_error', definition: 'text' },
  { name: 'backoff', definition: 'text' },
] as const

/** Resumable upgrade for a pre-publication or partially upgraded `jobs` table. */
export function buildD1DurableJobPublicationUpgradeSql(
  jobsTable = 'jobs',
  existingColumns: ReadonlySet<string> = new Set(),
): string[] {
  const missing = D1_DURABLE_JOB_PUBLICATION_COLUMNS.filter(column => !existingColumns.has(column.name))
  const addedPublicationColumn = missing.some(column => column.name === 'published_at')
  return [
    ...missing.map(column => `ALTER TABLE ${jobsTable} ADD COLUMN ${column.name} ${column.definition}`),
    ...(addedPublicationColumn
      ? [`UPDATE ${jobsTable} SET published_at = created_at, last_dispatched_at = created_at, dispatch_attempts = 1 WHERE published_at IS NULL`]
      : []),
    'DROP INDEX IF EXISTS idx_jobs_dispatchable',
    `CREATE INDEX idx_jobs_dispatchable ON ${jobsTable} (available_at) WHERE published_at IS NULL AND reserved_at IS NULL AND completed_at IS NULL AND failed_at IS NULL`,
    'PRAGMA optimize',
  ]
}

export const DURABLE_JOB_FAILURE_EVIDENCE_LIMIT = 8

type DurableJobFailureEvidence
  = | { _tag: 'release', at: number, description: string, delaySeconds: number, error?: string }
    | { _tag: 'stale-release', at: number, description: string }
    | { _tag: 'dlq-arrival', at: number, description: string, messageAttempts: number }
    | { _tag: 'orphan-redispatch', at: number, description: string }

const FAILURE_EVIDENCE_TEXT_LIMIT = 2_000

function boundedFailureText(value: string): string {
  return value.slice(0, FAILURE_EVIDENCE_TEXT_LIMIT)
}

function releaseEvidence(at: number, opts: ReleaseDurableJobOptions | undefined): DurableJobFailureEvidence {
  const error = opts?.error ? boundedFailureText(opts.error) : undefined
  return {
    _tag: 'release',
    at,
    description: `release@${at}: ${error ?? 'controlled release'}`,
    delaySeconds: opts?.delaySeconds ?? 0,
    ...(error ? { error } : {}),
  }
}

function staleReleaseEvidence(at: number, error: string): DurableJobFailureEvidence {
  return {
    _tag: 'stale-release',
    at,
    description: `stale-release@${at}: ${boundedFailureText(error)}`,
  }
}

function orphanRedispatchEvidence(at: number): DurableJobFailureEvidence {
  return {
    _tag: 'orphan-redispatch',
    at,
    description: `orphan-redispatch@${at}: recovery sweep re-sent this row to its queue`,
  }
}

function dlqArrivalEvidence(at: number, messageAttempts: number): DurableJobFailureEvidence {
  return {
    _tag: 'dlq-arrival',
    at,
    description: `dlq@${at}: Cloudflare retries exhausted (message attempts=${messageAttempts})`,
    messageAttempts,
  }
}

function validEvidenceArraySql(column: string): string {
  return `CASE
    WHEN json_valid(${column}) AND json_type(${column}) = 'array' THEN ${column}
    ELSE '[]'
  END`
}

function appendFailureEvidenceSql(column: string): string {
  const evidence = validEvidenceArraySql(column)
  return `json_insert(
    CASE
      WHEN json_array_length(${evidence}) >= ?
        THEN json_remove(${evidence}, '$[0]')
      ELSE ${evidence}
    END,
    '$[#]',
    json(?)
  )`
}

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
      attempts, max_attempts, backoff, available_at, created_at, published_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  const stageJobSql = `
    INSERT INTO ${jobsTable} (
      id, queue, job_type, batch_id, user_id, site_id, partner_id, trace_id, unique_key, payload,
      attempts, max_attempts, backoff, available_at, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  const stageJobOrIgnoreSql = stageJobSql.replace('INSERT INTO', 'INSERT OR IGNORE INTO')

  function bindJob(record: DurableJobRecord<Queue>, sql = insertJobSql): D1PreparedStatementLike<unknown> {
    return db.prepare(sql).bind(
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
      record.backoff ? JSON.stringify(record.backoff) : null,
      record.availableAt,
      record.createdAt,
      ...(sql === insertJobSql ? [record.createdAt] : []),
    )
  }

  function prepareStageJobs(records: readonly DurableJobRecord<Queue>[]): Result<D1PreparedDurableJobStage<Queue>, PrepareD1DurableJobStageError> {
    const duplicate = findDuplicateJobId(records)
    if (duplicate)
      return err({ _tag: 'duplicate-job-id', id: duplicate })
    return ok({
      records,
      statements: records.map(record => bindJob(record, stageJobSql)),
    })
  }

  return {
    async migrate() {
      const existingJobsTable = await db.prepare<{ name: string }>(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
      `).bind(jobsTable).first<{ name: string }>()
      const existingColumns = new Set(existingJobsTable
        ? (await all<{ name: string }>(db.prepare<{ name: string }>(`
            SELECT name FROM pragma_table_info(?)
          `).bind(jobsTable))).map(column => column.name)
        : [])
      const requiresPublicationUpgrade = existingJobsTable
        ? D1_DURABLE_JOB_PUBLICATION_COLUMNS.some(column => !existingColumns.has(column.name))
        : false
      // D1 exec() is intended for static maintenance work and accepts multiple
      // statements. One call avoids a network round trip per table/index.
      const migrationSql = existingJobsTable && !existingColumns.has('published_at')
        ? d1DurableJobMigrationSql.filter(statement => !statement.includes('idx_jobs_dispatchable'))
        : d1DurableJobMigrationSql
      await db.exec(migrationSql.join(';\n'))
      if (requiresPublicationUpgrade) {
        // Rows are backfilled only when this migration introduces published_at.
        // If a partial or external migration already created that column, retain
        // its null values as unpublished rather than guessing that a send occurred.
        await db.exec(buildD1DurableJobPublicationUpgradeSql(jobsTable, existingColumns).join(';\n'))
      }
    },

    async insertJob(record) {
      const result = await bindJob(record).run()
      return typeof result.meta?.changes === 'number'
        ? result.meta.changes > 0
        : result.success === true
    },

    async stageJob(record) {
      const result = await bindJob(record, stageJobOrIgnoreSql).run()
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
        const stmts = slice.map(record => bindJob(record))
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

    prepareStageJobs(records) {
      return prepareStageJobs(records)
    },

    async stageJobs(records) {
      const prepared = prepareStageJobs(records)
      if (!prepared.ok)
        return { status: 'invalid', error: prepared.error }
      if (records.length === 0)
        return { status: 'staged', records }
      if (typeof db.batch !== 'function')
        return { status: 'unsupported', reason: 'transactional-batch-unavailable' }
      return await db.batch(prepared.value.statements)
        .then((results): StageD1DurableJobsResult<Queue> => {
          const exact = results.length === records.length && results.every(result => result.meta?.changes === 1 || (result.meta?.changes === undefined && result.success === true))
          return exact
            ? { status: 'staged', records }
            : { status: 'failed', cause: new Error(`Durable stage affected ${results.reduce((sum, result) => sum + (result.meta?.changes ?? 0), 0)} of ${records.length} rows`) }
        })
        .catch((cause: unknown): StageD1DurableJobsResult<Queue> => ({ status: 'failed', cause }))
    },

    async markJobsPublished(ids, publishOpts) {
      if (ids.length === 0)
        return 0
      const at = publishOpts?.at ?? currentUnixSeconds()
      const result = await db.prepare(`
        UPDATE ${jobsTable}
        SET published_at = COALESCE(published_at, ?),
            last_dispatched_at = ?,
            dispatch_attempts = dispatch_attempts + 1,
            last_dispatch_error = NULL
        WHERE id IN (SELECT value FROM json_each(?))
          AND completed_at IS NULL
          AND failed_at IS NULL
      `).bind(at, at, JSON.stringify(ids)).run()
      return result.meta?.changes ?? 0
    },

    async noteJobsDispatchFailure(ids, cause, failureOpts) {
      if (ids.length === 0)
        return 0
      const at = failureOpts?.at ?? currentUnixSeconds()
      const result = await db.prepare(`
        UPDATE ${jobsTable}
        SET last_dispatched_at = ?,
            dispatch_attempts = dispatch_attempts + 1,
            last_dispatch_error = ?
        WHERE id IN (SELECT value FROM json_each(?))
          AND published_at IS NULL
          AND completed_at IS NULL
          AND failed_at IS NULL
      `).bind(at, describeCause(cause), JSON.stringify(ids)).run()
      return result.meta?.changes ?? 0
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
          AND published_at IS NOT NULL
          AND (reserved_at IS NULL OR reserved_at <= ?)
          AND available_at <= ?
          AND completed_at IS NULL
          AND failed_at IS NULL
        RETURNING *
      `).bind(now, id, reclaimBefore, now).first<D1DurableJobRecord<Queue>>()
      if (job)
        await runLifecycleHook(() => opts.onJobClaimed?.({ job }), opts.onObserverError, { stage: 'claimed', jobId: job.id })
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
      const resultUpdate = await db.prepare(`
        UPDATE ${jobsTable}
        SET completed_at = unixepoch(), reserved_at = NULL,
            duration_ms = COALESCE(?, duration_ms),
            rows_fetched = COALESCE(?, rows_fetched),
            rows_inserted = COALESCE(?, rows_inserted),
            d1_rows_read = COALESCE(?, d1_rows_read),
            d1_rows_written = COALESCE(?, d1_rows_written)
        WHERE id = ?
          AND reserved_at = ?
          AND attempts = ?
          AND completed_at IS NULL
          AND failed_at IS NULL
      `).bind(
        durationMs,
        stats('rowsFetched') ?? null,
        stats('rowsInserted') ?? null,
        stats('d1RowsRead') ?? null,
        stats('d1RowsWritten') ?? null,
        job.id,
        job.reserved_at,
        job.attempts,
      ).run()
      assertOwnedMutation(resultUpdate, job.id)
      await runLifecycleHook(() => opts.onJobCompleted?.({ job, durationMs, result }), opts.onObserverError, { stage: 'completed', jobId: job.id })
    },

    async failJob(job, error, failOpts) {
      const insertStatement = db.prepare(`
        INSERT OR REPLACE INTO ${failedJobsTable} (
          id, queue, job_type, batch_id, user_id, site_id, partner_id, trace_id, unique_key, payload,
          exception, attempts, max_attempts, failed_at
        )
        SELECT
          id, queue, job_type, batch_id, user_id, site_id, partner_id, trace_id, unique_key, payload,
          ?, attempts, max_attempts, unixepoch()
        FROM ${jobsTable}
        WHERE id = ?
          AND reserved_at = ?
          AND attempts = ?
          AND completed_at IS NULL
          AND failed_at IS NULL
      `).bind(
        error,
        job.id,
        job.reserved_at,
        job.attempts,
      )
      const deleteStatement = db.prepare(`
        DELETE FROM ${jobsTable}
        WHERE id = ?
          AND reserved_at = ?
          AND attempts = ?
          AND completed_at IS NULL
          AND failed_at IS NULL
      `).bind(job.id, job.reserved_at, job.attempts)
      const [insert, deleted] = typeof db.batch === 'function'
        ? await db.batch([insertStatement, deleteStatement])
        : [await insertStatement.run(), await deleteStatement.run()]
      assertOwnedMutation(insert!, job.id)
      assertOwnedMutation(deleted!, job.id)
      // `exception` persists the full rendering (stack + `cause` chain, see
      // `describeCauseWithStack`) because that row is the only record of the defect.
      // The hook is telemetry — sinks put this string in a Sentry issue title, a
      // realtime `job-status` payload, an Analytics Engine blob — so it gets the
      // HEADLINE only (`"TypeError: <message>"`, always the stack's first line).
      // A caller passing a plain single-line message is unaffected. `cause` carries the
      // original throw so an error tracker reports it directly, stack and all.
      await runLifecycleHook(() => opts.onJobFailed?.({ job, error: headlineOf(error), cause: failOpts?.cause }), opts.onObserverError, { stage: 'failed', jobId: job.id })
    },

    async releaseJob(job, releaseOpts) {
      const releasedAt = currentUnixSeconds()
      const evidence = releaseEvidence(releasedAt, releaseOpts)
      const result = await db.prepare(`
        UPDATE ${jobsTable}
        SET reserved_at = NULL,
            available_at = ?,
            last_error = COALESCE(?, last_error),
            retry_reasons = ${appendFailureEvidenceSql('retry_reasons')}
        WHERE id = ?
          AND reserved_at = ?
          AND attempts = ?
          AND completed_at IS NULL
          AND failed_at IS NULL
      `).bind(
        resolveAvailableAt(releaseOpts, releasedAt),
        releaseOpts?.error ?? null,
        DURABLE_JOB_FAILURE_EVIDENCE_LIMIT,
        JSON.stringify(evidence),
        job.id,
        job.reserved_at,
        job.attempts,
      ).run()
      assertOwnedMutation(result, job.id)
      await runLifecycleHook(() => opts.onJobReleased?.({ job, opts: releaseOpts }), opts.onObserverError, { stage: 'released', jobId: job.id })
    },

    async noteOrphanRedispatch(ids, opts) {
      if (!ids.length)
        return 0
      const at = opts?.at ?? currentUnixSeconds()
      const evidence = JSON.stringify(orphanRedispatchEvidence(at))
      const result = await db.prepare(`
        UPDATE ${jobsTable}
        SET retry_reasons = ${appendFailureEvidenceSql('retry_reasons')}
        WHERE id IN (SELECT value FROM json_each(?))
          AND completed_at IS NULL
          AND failed_at IS NULL
      `).bind(
        DURABLE_JOB_FAILURE_EVIDENCE_LIMIT,
        evidence,
        JSON.stringify(ids),
      ).run()
      return result.meta?.changes ?? 0
    },

    async noteDlqArrival(id, input) {
      const at = input.at ?? currentUnixSeconds()
      const evidence = dlqArrivalEvidence(at, input.messageAttempts)
      const row = await db.prepare<{ id: string }>(`
        UPDATE ${jobsTable}
        SET retry_reasons = ${appendFailureEvidenceSql('retry_reasons')}
        WHERE id = ?
          AND completed_at IS NULL
          AND failed_at IS NULL
        RETURNING id
      `).bind(
        DURABLE_JOB_FAILURE_EVIDENCE_LIMIT,
        JSON.stringify(evidence),
        id,
      ).first<{ id: string }>()
      return row ? { _tag: 'recorded' } : { _tag: 'obsolete' }
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
      const publicationPredicate = query.publication === 'all'
        ? '1 = 1'
        : query.publication === 'published'
          ? 'published_at IS NOT NULL'
          : 'published_at IS NULL'
      const orderColumn = query.publication === 'all' && query.createdBefore != null
        ? 'created_at'
        : 'available_at'
      return await all<D1DurableJobRecord<Queue>>(db.prepare<D1DurableJobRecord<Queue>>(`
        SELECT *
        FROM ${jobsTable}
        WHERE reserved_at IS NULL
          AND ${publicationPredicate}
          AND available_at <= ?
          AND (? IS NULL OR created_at <= ?)
          AND (
            ? IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM json_each(${validEvidenceArraySql('retry_reasons')})
              WHERE json_extract(value, '$._tag') = 'stale-release'
                AND CAST(json_extract(value, '$.at') AS INTEGER) > ?
            )
          )
          AND (
            ? IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM json_each(${validEvidenceArraySql('retry_reasons')})
              WHERE json_extract(value, '$._tag') = 'orphan-redispatch'
                AND CAST(json_extract(value, '$.at') AS INTEGER) > ?
            )
          )
          AND completed_at IS NULL
          AND failed_at IS NULL
        ORDER BY ${orderColumn} ASC
        LIMIT ?
      `).bind(
        query.now ?? currentUnixSeconds(),
        query.createdBefore ?? null,
        query.createdBefore ?? null,
        query.staleReleasedBefore ?? null,
        query.staleReleasedBefore ?? null,
        query.redispatchedBefore ?? null,
        query.redispatchedBefore ?? null,
        query.limit ?? 100,
      ))
    },

    async findStaleReservedJobs(query) {
      return await all<D1DurableJobRecord<Queue>>(db.prepare<D1DurableJobRecord<Queue>>(`
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
      const releasedAt = query.now ?? currentUnixSeconds()
      const error = query.error ?? 'stale-reservation'
      const evidence = staleReleaseEvidence(releasedAt, error)
      const result = await db.prepare(`
        UPDATE ${jobsTable}
        SET reserved_at = NULL,
            available_at = ?,
            last_error = COALESCE(?, last_error),
            retry_reasons = ${appendFailureEvidenceSql('retry_reasons')}
        WHERE id IN (
          SELECT id
          FROM ${jobsTable}
          WHERE reserved_at IS NOT NULL
            AND reserved_at <= ?
            AND completed_at IS NULL
            AND failed_at IS NULL
            AND (max_attempts IS NULL OR attempts < max_attempts)
          ORDER BY reserved_at ASC
          LIMIT ?
        )
      `).bind(
        query.availableAt ?? query.now ?? currentUnixSeconds(),
        query.error ?? null,
        DURABLE_JOB_FAILURE_EVIDENCE_LIMIT,
        JSON.stringify(evidence),
        query.staleBefore,
        query.limit ?? 100,
      ).run()
      return result.meta?.changes ?? 0
    },

    // A reservation that goes stale (worker evicted before settling) is normally
    // revived by `releaseStaleReservedJobs`. But a perpetually-stale job would be
    // revived forever, its `attempts` climbing past `max_attempts` while never
    // reaching the consumer's terminal branch (which only fires on an actual
    // throw). Honour the Laravel cap here: move stale rows that have already hit
    // `attempts >= max_attempts` to `failed_jobs` instead. `INSERT OR REPLACE`
    // keeps it idempotent, and the DELETE only removes rows that made it into
    // `failed_jobs`. Native D1 uses one transactional batch for the move; small
    // test adapters without batch support retain the idempotent sequential
    // fallback. `max_attempts IS NOT NULL` leaves uncapped jobs untouched.
    async failStaleReservedJobs(query) {
      const now = query.now ?? currentUnixSeconds()
      const exception = query.error ?? 'stale-reservation: exhausted retries'
      const evidenceArray = validEvidenceArraySql('retry_reasons')
      const insertStatement = db.prepare<{ id: string, queue: Queue, batchId: string | null, jobType: string, payload: string, attempts: number, exception: string }>(`
        INSERT OR REPLACE INTO ${failedJobsTable} (
          id, queue, job_type, batch_id, user_id, site_id, partner_id, trace_id, unique_key, payload,
          exception, attempts, max_attempts, failed_at
        )
        SELECT
          id, queue, job_type, batch_id, user_id, site_id, partner_id, trace_id, unique_key, payload,
          ? || ' (attempts=' || attempts
            || ', reserved ' || CAST(MAX(0, ? - reserved_at) AS INTEGER) || 's ago'
            || '; last error: ' || COALESCE(last_error, 'none')
            || '; last evidence: ' || COALESCE(
              json_extract(${evidenceArray}, '$[#-1].description'),
              'none, no release recorded, possible isolate termination'
            )
            || ')',
          attempts, max_attempts, ?
        FROM ${jobsTable}
        WHERE reserved_at IS NOT NULL
          AND reserved_at <= ?
          AND completed_at IS NULL
          AND failed_at IS NULL
          AND max_attempts IS NOT NULL
          AND attempts >= max_attempts
        ORDER BY reserved_at ASC
        LIMIT ?
        RETURNING id, queue, batch_id AS batchId, job_type AS jobType, payload, attempts, exception
      `).bind(
        exception,
        now,
        now,
        query.staleBefore,
        query.limit ?? 100,
      )

      const deleteStatement = db.prepare(`
        DELETE FROM ${jobsTable}
        WHERE reserved_at IS NOT NULL
          AND reserved_at <= ?
          AND completed_at IS NULL
          AND failed_at IS NULL
          AND max_attempts IS NOT NULL
          AND attempts >= max_attempts
          AND id IN (SELECT id FROM ${failedJobsTable})
          AND id IN (
            SELECT id
            FROM ${jobsTable}
            WHERE reserved_at IS NOT NULL
              AND reserved_at <= ?
              AND completed_at IS NULL
              AND failed_at IS NULL
              AND max_attempts IS NOT NULL
              AND attempts >= max_attempts
            ORDER BY reserved_at ASC
            LIMIT ?
          )
      `).bind(query.staleBefore, query.staleBefore, query.limit ?? 100)

      if (typeof db.batch === 'function') {
        const [inserted] = await db.batch([insertStatement, deleteStatement])
        return (inserted?.results ?? []) as Array<{ id: string, queue: Queue, batchId: string | null, jobType: string, payload: string, attempts: number, exception: string }>
      }

      const inserted = insertStatement.all
        ? await insertStatement.all<{ id: string, queue: Queue, batchId: string | null, jobType: string, payload: string, attempts: number, exception: string }>()
        : await insertStatement.run()
      await deleteStatement.run()
      return (inserted.results ?? []) as Array<{ id: string, queue: Queue, batchId: string | null, jobType: string, payload: string, attempts: number, exception: string }>
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
      // Only soft-completed rows (completed_at IS NOT NULL) — never in-flight
      // ones, and never member evidence for a batch that is still unfinished.
      return await pruneInChunks(
        db,
        jobsTable,
        `completed_at IS NOT NULL
          AND completed_at <= ?
          AND (
            batch_id IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM ${batchesTable}
              WHERE ${batchesTable}.id = ${jobsTable}.batch_id
                AND ${batchesTable}.finished_at IS NULL
            )
          )`,
        query,
      )
    },

    async pruneFailedJobs(query) {
      // failed_jobs.failed_at is always set. Preserve failed-member evidence
      // while its parent batch is unfinished so orphaned-batch recovery can
      // prove every expected member reached a terminal state.
      return await pruneInChunks(
        db,
        failedJobsTable,
        `failed_at <= ?
          AND (
            batch_id IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM ${batchesTable}
              WHERE ${batchesTable}.id = ${failedJobsTable}.batch_id
                AND ${batchesTable}.finished_at IS NULL
            )
          )`,
        query,
      )
    },

    async pruneFinishedBatches(query) {
      // Only terminal batches (finished_at IS NOT NULL), AND only once no `jobs`
      // row still references them — `jobs.batch_id` FKs `job_batches(id)`, so
      // deleting a batch with a lingering (not-yet-pruned) completed member would
      // violate the FK where D1 enforces it. This makes the prune FK-safe even
      // when completed-jobs retention is set LONGER than batch retention; such a
      // batch is simply pruned on a later run once its members age out. Finished
      // child batches are also retained while their parent is unfinished because
      // they are the parent's terminal-member evidence.
      return await pruneInChunks(
        db,
        batchesTable,
        `finished_at IS NOT NULL
          AND finished_at <= ?
          AND NOT EXISTS (
            SELECT 1
            FROM ${jobsTable}
            WHERE ${jobsTable}.batch_id = ${batchesTable}.id
          )
          AND (
            parent_batch_id IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM ${batchesTable} parent_batches
              WHERE parent_batches.id = ${batchesTable}.parent_batch_id
                AND parent_batches.finished_at IS NULL
            )
          )`,
        query,
      )
    },
  }
}

/** Strict, transactional staging through a repository's D1 batch boundary. */
export async function stagePreparedDurableJobs<Queue extends string>(
  repository: Pick<D1DurableJobRepository<Queue>, 'stageJobs'>,
  records: readonly DurableJobRecord<Queue>[],
): Promise<StageD1DurableJobsResult<Queue>> {
  return await repository.stageJobs(records)
}

function findDuplicateJobId<Queue extends string>(records: readonly DurableJobRecord<Queue>[]): string | undefined {
  const seen = new Set<string>()
  for (const record of records) {
    if (seen.has(record.id))
      return record.id
    seen.add(record.id)
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

async function runLifecycleHook(
  fn: () => void | Promise<void>,
  fallback: D1DurableJobRepositoryOptions['onObserverError'],
  context: { stage: 'claimed' | 'completed' | 'failed' | 'released', jobId: string },
): Promise<void> {
  await Promise.resolve().then(fn).catch(async (cause: unknown) => {
    if (fallback) {
      await Promise.resolve().then(() => fallback({ ...context, cause })).catch((fallbackCause: unknown) => {
        console.error('[nuxt-cf-jobs] D1 observer error fallback failed', { ...context, cause, fallbackCause })
      })
      return
    }
    console.error('[nuxt-cf-jobs] D1 observer error', { ...context, cause })
  })
}

function assertOwnedMutation(result: { meta?: { changes?: number }, success?: boolean }, jobId: string): void {
  if (typeof result.meta?.changes === 'number' ? result.meta.changes > 0 : result.success === true)
    return
  throw new DurableJobOwnershipError(jobId)
}

function resolveAvailableAt(opts: ReleaseDurableJobOptions | undefined, now = currentUnixSeconds()): number {
  if (typeof opts?.availableAt === 'number')
    return opts.availableAt
  return now + (opts?.delaySeconds ?? 0)
}

async function all<T>(statement: D1PreparedStatementLike<T>): Promise<T[]> {
  const result = await statement.all?.<T>()
  return result?.results ?? []
}
