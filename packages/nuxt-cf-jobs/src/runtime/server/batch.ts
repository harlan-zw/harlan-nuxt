import type { D1DatabaseLike } from './d1'
import type {
  DispatchDurableJobBatchResult,
  DurableJobContinuation,
  DurableJobPublicationRepository,
  DurableJobRecord,
  QueuePublisher,
} from './outbox'
import {
  dispatchDurableJobBatch,
  parseDurableJobContinuation,
  publishDurableJobBatch,
  serializeDurableJobContinuation,
} from './outbox'

// ============================================
// Batch records + store contract
// ============================================

/** A `job_batches` row as the lifecycle helpers consume it (post-decrement view). */
export interface DurableBatchRecord {
  id: string
  name: string | null
  parentBatchId: string | null
  totalJobs: number
  pendingJobs: number
  failedJobs: number
  /** Serialized {@link DurableJobContinuation} (see `serializeDurableJobContinuation`). */
  onFinish: string | null
  allowFailures: boolean
  siteId: string | null
  userId: number | null
  finishedAt: number | null
}

export interface InsertDurableBatchInput {
  id: string
  name?: string | null
  parentBatchId?: string | null
  totalJobs: number
  pendingJobs: number
  failedJobs?: number
  onFinish?: string | null
  allowFailures?: boolean
  siteId?: string | null
  userId?: number | null
}

/**
 * Persistence contract for batch bookkeeping. The atomicity guarantee that makes
 * `onFinish` fire exactly once lives entirely in `decrementPending`: it MUST
 * decrement `pending_jobs` and return the *post-decrement* row in a single atomic
 * step, so that under concurrent settles exactly one caller observes
 * `pendingJobs === 0`. The D1 implementation gets this from SQLite's single-writer
 * serialization of `UPDATE ... RETURNING`.
 */
export interface DurableBatchStore {
  insertBatch: (input: InsertDurableBatchInput) => Promise<void>
  /**
   * Atomically insert one batch and every member row. A conflict or failed
   * member insert must roll back the batch row and all sibling members.
   */
  insertBatchWithJobs: <Queue extends string>(
    input: InsertDurableBatchInput,
    records: readonly DurableJobRecord<Queue>[],
  ) => Promise<void>
  markJobsPublished?: DurableJobPublicationRepository['markJobsPublished']
  noteJobsDispatchFailure?: DurableJobPublicationRepository['noteJobsDispatchFailure']
  /**
   * Atomically decrement `pending_jobs` (and `failed_jobs` when `failed`), set
   * `finished_at` on the 1→0 transition, and return the resulting row. Returns
   * `null` when the batch does not exist or has already settled.
   */
  decrementPending: (batchId: string, opts?: { failed?: boolean }) => Promise<DurableBatchRecord | null>
  /** Resolve the batch a job belongs to (checks active then failed jobs). */
  getJobBatchId: (jobId: string) => Promise<string | null>
  /** Grow a batch's counters (used for parent batches / dynamically-added members). */
  incrementCounters?: (batchId: string, opts?: { by?: number }) => Promise<void>
  /**
   * Find old pending batches whose member rows prove every job is already
   * terminal. Implementations must not treat "no remaining member rows" as
   * terminal proof; completed/failed member evidence can be pruned separately.
   */
  findOrphanedBatches?: (query: { before: number, limit?: number }) => Promise<DurableBatchRecord[]>
  /**
   * Find old pending batches that have no active members left but cannot be
   * safely finished because terminal evidence is missing.
   */
  findUnrecoverableOrphanedBatches?: (query: { before: number, limit?: number }) => Promise<DurableBatchRecord[]>
  /**
   * Atomically finish one orphaned batch if it is still pending and still has
   * terminal evidence for every member. Returns the post-finish row, or `null`
   * when another worker won or the row is no longer safely recoverable.
   */
  finishOrphanedBatch?: (batchId: string, query?: { now?: number }) => Promise<DurableBatchRecord | null>
  /**
   * Legacy cleanup helper: close old pending batches that are provably terminal.
   * Prefer {@link recoverOrphanedBatches} when `onFinish` must be fired.
   */
  finishOrphanedBatches?: (query: { before: number, now?: number, limit?: number }) => Promise<number>
}

// ============================================
// D1-backed store
// ============================================

export interface D1DurableBatchStoreOptions {
  batchesTable?: string
  jobsTable?: string
  failedJobsTable?: string
}

function mapBatchRow(row: Record<string, unknown>): DurableBatchRecord {
  return {
    id: row.id as string,
    name: (row.name as string | null) ?? null,
    parentBatchId: (row.parent_batch_id as string | null) ?? null,
    totalJobs: row.total_jobs as number,
    pendingJobs: row.pending_jobs as number,
    failedJobs: row.failed_jobs as number,
    onFinish: (row.on_finish as string | null) ?? null,
    allowFailures: (row.allow_failures as number | null) === 1,
    siteId: (row.site_id as string | null) ?? null,
    userId: (row.user_id as number | null) ?? null,
    finishedAt: (row.finished_at as number | null) ?? null,
  }
}

export function createD1DurableBatchStore(
  db: D1DatabaseLike,
  opts: D1DurableBatchStoreOptions = {},
): DurableBatchStore {
  const batches = opts.batchesTable ?? 'job_batches'
  const jobs = opts.jobsTable ?? 'jobs'
  const failedJobs = opts.failedJobsTable ?? 'failed_jobs'

  return {
    async insertBatch(input) {
      await db.prepare(`
        INSERT INTO ${batches} (
          id, name, parent_batch_id, total_jobs, pending_jobs, failed_jobs,
          on_finish, allow_failures, site_id, user_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `).bind(
        input.id,
        input.name ?? null,
        input.parentBatchId ?? null,
        input.totalJobs,
        input.pendingJobs,
        input.failedJobs ?? 0,
        input.onFinish ?? null,
        input.allowFailures ? 1 : 0,
        input.siteId ?? null,
        input.userId ?? null,
      ).run()
    },

    async insertBatchWithJobs(input, records) {
      if (typeof db.batch !== 'function')
        throw new Error('Atomic job batch creation requires D1Database.batch')

      const memberRows = records.map(record => ({
        id: record.id,
        queue: record.queue,
        jobType: record.jobType,
        batchId: record.batchId ?? null,
        userId: record.userId ?? null,
        siteId: record.siteId ?? null,
        partnerId: record.partnerId ?? null,
        traceId: record.traceId,
        uniqueKey: record.uniqueKey ?? null,
        payload: record.payload,
        attempts: record.attempts,
        maxAttempts: record.maxAttempts,
        backoff: record.backoff ? JSON.stringify(record.backoff) : null,
        availableAt: record.availableAt,
        createdAt: record.createdAt,
      }))
      const statements = [
        db.prepare(`
          INSERT INTO ${batches} (
            id, name, parent_batch_id, total_jobs, pending_jobs, failed_jobs,
            on_finish, allow_failures, site_id, user_id, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
        `).bind(
          input.id,
          input.name ?? null,
          input.parentBatchId ?? null,
          input.totalJobs,
          input.pendingJobs,
          input.failedJobs ?? 0,
          input.onFinish ?? null,
          input.allowFailures ? 1 : 0,
          input.siteId ?? null,
          input.userId ?? null,
        ),
        db.prepare(`
          INSERT INTO ${jobs} (
            id, queue, job_type, batch_id, user_id, site_id, partner_id,
            trace_id, unique_key, payload, attempts, max_attempts,
            backoff, available_at, created_at
          )
          SELECT
            json_extract(value, '$.id'),
            json_extract(value, '$.queue'),
            json_extract(value, '$.jobType'),
            json_extract(value, '$.batchId'),
            json_extract(value, '$.userId'),
            json_extract(value, '$.siteId'),
            json_extract(value, '$.partnerId'),
            json_extract(value, '$.traceId'),
            json_extract(value, '$.uniqueKey'),
            json_extract(value, '$.payload'),
            json_extract(value, '$.attempts'),
            json_extract(value, '$.maxAttempts'),
            json_extract(value, '$.backoff'),
            json_extract(value, '$.availableAt'),
            json_extract(value, '$.createdAt')
          FROM json_each(?)
        `).bind(JSON.stringify(memberRows)),
      ]
      if (input.parentBatchId) {
        statements.push(db.prepare(`
          UPDATE ${batches}
          SET total_jobs = total_jobs + 1,
              pending_jobs = pending_jobs + 1,
              updated_at = unixepoch()
          WHERE id = ?
        `).bind(input.parentBatchId))
      }
      await db.batch(statements)
    },

    async markJobsPublished(ids, publishOpts) {
      if (ids.length === 0)
        return 0
      const at = publishOpts?.at ?? Math.floor(Date.now() / 1000)
      const result = await db.prepare(`
        UPDATE ${jobs}
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
      const at = failureOpts?.at ?? Math.floor(Date.now() / 1000)
      const error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
      const result = await db.prepare(`
        UPDATE ${jobs}
        SET last_dispatched_at = ?,
            dispatch_attempts = dispatch_attempts + 1,
            last_dispatch_error = ?
        WHERE id IN (SELECT value FROM json_each(?))
          AND published_at IS NULL
          AND completed_at IS NULL
          AND failed_at IS NULL
      `).bind(at, error, JSON.stringify(ids)).run()
      return result.meta?.changes ?? 0
    },

    async decrementPending(batchId, decOpts) {
      const row = await db.prepare<Record<string, unknown>>(`
        UPDATE ${batches}
        SET pending_jobs = pending_jobs - 1,
            failed_jobs = failed_jobs + ?,
            updated_at = unixepoch(),
            finished_at = CASE WHEN pending_jobs = 1 AND finished_at IS NULL THEN unixepoch() ELSE finished_at END
        WHERE id = ? AND pending_jobs > 0
        RETURNING id, name, parent_batch_id, total_jobs, pending_jobs, failed_jobs, on_finish, allow_failures, site_id, user_id, finished_at
      `).bind(decOpts?.failed ? 1 : 0, batchId).first<Record<string, unknown>>()
      return row ? mapBatchRow(row) : null
    },

    async getJobBatchId(jobId) {
      const job = await db.prepare<{ batch_id: string | null }>(`SELECT batch_id FROM ${jobs} WHERE id = ?`)
        .bind(jobId)
        .first<{ batch_id: string | null }>()
      if (job?.batch_id)
        return job.batch_id
      const failed = await db.prepare<{ batch_id: string | null }>(`SELECT batch_id FROM ${failedJobs} WHERE id = ?`)
        .bind(jobId)
        .first<{ batch_id: string | null }>()
      return failed?.batch_id ?? null
    },

    async incrementCounters(batchId, incOpts) {
      const by = incOpts?.by ?? 1
      await db.prepare(`
        UPDATE ${batches}
        SET total_jobs = total_jobs + ?, pending_jobs = pending_jobs + ?, updated_at = unixepoch()
        WHERE id = ?
      `).bind(by, by, batchId).run()
    },

    async findOrphanedBatches(query) {
      return await all<Record<string, unknown>>(db.prepare(`
        SELECT id, name, parent_batch_id, total_jobs, pending_jobs, failed_jobs, on_finish, allow_failures, site_id, user_id, finished_at
        FROM ${batches}
        WHERE ${orphanedBatchPredicate(batches, jobs, failedJobs, 'created_at <= ?')}
        ORDER BY created_at ASC
        LIMIT ?
      `).bind(query.before, query.limit ?? 100)).then(rows => rows.map(mapBatchRow))
    },

    async findUnrecoverableOrphanedBatches(query) {
      return await all<Record<string, unknown>>(db.prepare(`
        SELECT id, name, parent_batch_id, total_jobs, pending_jobs, failed_jobs, on_finish, allow_failures, site_id, user_id, finished_at
        FROM ${batches}
        WHERE ${orphanedBatchPredicate(batches, jobs, failedJobs, 'created_at <= ?', 'unrecoverable')}
        ORDER BY created_at ASC
        LIMIT ?
      `).bind(query.before, query.limit ?? 100)).then(rows => rows.map(mapBatchRow))
    },

    async finishOrphanedBatch(batchId, query = {}) {
      const now = query.now ?? Math.floor(Date.now() / 1000)
      const row = await db.prepare<Record<string, unknown>>(`
        UPDATE ${batches}
        SET pending_jobs = 0, updated_at = ?, finished_at = COALESCE(finished_at, ?)
        WHERE id = ?
          AND ${orphanedBatchPredicate(batches, jobs, failedJobs)}
        RETURNING id, name, parent_batch_id, total_jobs, pending_jobs, failed_jobs, on_finish, allow_failures, site_id, user_id, finished_at
      `).bind(now, now, batchId).first<Record<string, unknown>>()
      return row ? mapBatchRow(row) : null
    },

    async finishOrphanedBatches(query) {
      const now = query.now ?? Math.floor(Date.now() / 1000)
      const result = await db.prepare(`
        UPDATE ${batches}
        SET pending_jobs = 0, updated_at = ?, finished_at = COALESCE(finished_at, ?)
        WHERE id IN (
          SELECT id
          FROM ${batches}
          WHERE ${orphanedBatchPredicate(batches, jobs, failedJobs, 'created_at <= ?')}
          LIMIT ?
        )
      `).bind(now, now, query.before, query.limit ?? 100).run()
      return result.meta?.changes ?? 0
    },
  }
}

// ============================================
// Create a batch
// ============================================

export interface CreateJobBatchOptions<
  Name extends string = string,
  Payload extends object = Record<string, unknown>,
  Queue extends string = string,
> {
  store: DurableBatchStore
  publisher: Pick<QueuePublisher<Queue>, 'sendBatch'>
  /** Prepared job records (use `prepareDurableJob`). Their `batchId` is overwritten with this batch's id. */
  jobs: Array<DurableJobRecord<Queue>>
  name?: string
  siteId?: string
  userId?: number
  parentBatchId?: string
  allowFailures?: boolean
  /** Fired (via the consumer's `settleBatchMember`) once every member is terminal. */
  onFinish?: DurableJobContinuation<Name, Payload, Queue>
  delaySeconds?: number
  /** Supply for deterministic ids (tests); defaults to a random UUID. */
  batchId?: string
}

export interface CreateJobBatchResult {
  batchId: string
  jobIds: string[]
  dispatched: Array<DispatchDurableJobBatchResult>
}

/**
 * Atomically register a batch of jobs: insert the `job_batches` row with
 * `pending_jobs = jobs.length`, persist the member rows, then dispatch them to
 * their queues. The batch's `onFinish` fires once every member settles via
 * {@link settleBatchMember} in the consumer.
 *
 * An empty `jobs` array is a no-op (no batch row, no `onFinish`) — there would be
 * no member to drive `pending_jobs` to 0, so a zero-member batch would hang.
 */
export async function createJobBatch<
  Name extends string = string,
  Payload extends object = Record<string, unknown>,
  Queue extends string = string,
>(opts: CreateJobBatchOptions<Name, Payload, Queue>): Promise<CreateJobBatchResult> {
  if (opts.jobs.length === 0)
    return { batchId: '', jobIds: [], dispatched: [] }

  const batchId = opts.batchId ?? crypto.randomUUID()
  const records = opts.jobs.map(job => (job.batchId === batchId ? job : { ...job, batchId }))

  const batchInput: InsertDurableBatchInput = {
    id: batchId,
    name: opts.name ?? null,
    parentBatchId: opts.parentBatchId ?? null,
    totalJobs: records.length,
    pendingJobs: records.length,
    failedJobs: 0,
    onFinish: opts.onFinish ? serializeDurableJobContinuation(opts.onFinish) : null,
    allowFailures: opts.allowFailures ?? false,
    siteId: opts.siteId ?? null,
    userId: opts.userId ?? null,
  }
  await opts.store.insertBatchWithJobs(batchInput, records).catch((cause) => {
    throw new Error(`Failed to create nuxt-cf-jobs batch ${batchId} atomically`, { cause })
  })

  const dispatched = opts.store.markJobsPublished && opts.store.noteJobsDispatchFailure
    ? (await publishDurableJobBatch(
        opts.store as DurableBatchStore & DurableJobPublicationRepository,
        opts.publisher,
        records,
        opts.delaySeconds ? { delaySeconds: opts.delaySeconds } : undefined,
      )).map((result): DispatchDurableJobBatchResult<Queue> => {
        if (result.status === 'published')
          return { queue: result.queue, status: 'sent' }
        if (result.status === 'not-dispatched')
          return { queue: result.queue, status: 'not-dispatched' }
        return { queue: result.queue, status: 'failed', cause: result.cause }
      })
    : await dispatchDurableJobBatch(
        opts.publisher,
        records,
        opts.delaySeconds ? { delaySeconds: opts.delaySeconds } : undefined,
      )

  return { batchId, jobIds: records.map(r => r.id), dispatched }
}

// ============================================
// Settle a batch member (single-winner + onFinish)
// ============================================

export interface BatchProgress {
  batchId: string
  name: string | null
  siteId: string | null
  completed: number
  total: number
  failed: number
  finishedAt: number | null
}

export interface SettleBatchMemberResult {
  batchComplete: boolean
  onFinishDispatched: boolean
  progress?: BatchProgress
}

export interface DispatchBatchOnFinishInput<
  Name extends string = string,
  Payload extends object = Record<string, unknown>,
  Queue extends string = string,
> {
  /** The batch's `onFinish` continuation, with `batchId` injected into its payload. */
  continuation: DurableJobContinuation<Name, Payload & { batchId: string }, Queue>
  batch: DurableBatchRecord
}

export interface SettleBatchMemberOptions<
  Name extends string = string,
  Payload extends object = Record<string, unknown>,
  Queue extends string = string,
> {
  store: DurableBatchStore
  /** Resolve the batch from a settled job id. Provide this OR `batchId`. */
  jobId?: string
  /** Settle directly against a known batch id (skips the job→batch lookup). */
  batchId?: string
  /** True when the member permanently failed (still counts toward terminal). */
  failed?: boolean
  /**
   * Run the batch's `onFinish` continuation. The app decides how (enqueue durably,
   * dispatch inline, …). Called for the winning settle only, and again for any
   * parent batch that completes as a result.
   */
  dispatchOnFinish?: (input: DispatchBatchOnFinishInput<Name, Payload, Queue>) => void | Promise<void>
}

export interface RecoverOrphanedBatchesOptions<
  Name extends string = string,
  Payload extends object = Record<string, unknown>,
  Queue extends string = string,
> {
  store: DurableBatchStore
  before: number
  now?: number
  limit?: number
  dispatchOnFinish?: SettleBatchMemberOptions<Name, Payload, Queue>['dispatchOnFinish']
}

export interface RecoverOrphanedBatchesResult {
  scanned: number
  recovered: number
  onFinishDispatched: number
  onFinishFailed: number
  skipped: number
  unrecoverable: number
  batches: DurableBatchRecord[]
  unrecoverableBatches: DurableBatchRecord[]
  errors: Array<{ batchId: string, error: unknown }>
}

function toProgress(batch: DurableBatchRecord): BatchProgress {
  return {
    batchId: batch.id,
    name: batch.name,
    siteId: batch.siteId,
    completed: batch.totalJobs - batch.pendingJobs,
    total: batch.totalJobs,
    failed: batch.failedJobs,
    finishedAt: batch.finishedAt,
  }
}

async function fireOnFinishChain<
  Name extends string,
  Payload extends object,
  Queue extends string,
>(
  store: DurableBatchStore,
  batch: DurableBatchRecord,
  dispatch: SettleBatchMemberOptions<Name, Payload, Queue>['dispatchOnFinish'],
): Promise<boolean> {
  let dispatched = false
  if (batch.onFinish && dispatch) {
    const continuation = parseDurableJobContinuation<Name, Payload>(batch.onFinish)
    await dispatch({
      continuation: {
        ...continuation,
        payload: { ...continuation.payload, batchId: batch.id },
      } as DispatchBatchOnFinishInput<Name, Payload, Queue>['continuation'],
      batch,
    })
    dispatched = true
  }

  // Bubble up: a completed child decrements its parent; the parent fires when it
  // in turn reaches 0. Parent decrements are never counted as failures.
  if (batch.parentBatchId) {
    const parent = await store.decrementPending(batch.parentBatchId)
    if (parent && parent.pendingJobs === 0)
      dispatched = (await fireOnFinishChain(store, parent, dispatch)) || dispatched
  }

  return dispatched
}

/**
 * Recover batches whose member jobs already reached a terminal state but whose
 * `pending_jobs` decrement was missed. This mirrors the normal settle path:
 * one atomic finisher closes the batch, then the batch/parent `onFinish` chain is
 * fired by the same caller. Stores must only return batches with terminal member
 * evidence for every expected job.
 */
export async function recoverOrphanedBatches<
  Name extends string = string,
  Payload extends object = Record<string, unknown>,
  Queue extends string = string,
>(opts: RecoverOrphanedBatchesOptions<Name, Payload, Queue>): Promise<RecoverOrphanedBatchesResult> {
  if (!opts.store.findOrphanedBatches || !opts.store.finishOrphanedBatch)
    return { scanned: 0, recovered: 0, onFinishDispatched: 0, onFinishFailed: 0, skipped: 0, unrecoverable: 0, batches: [], unrecoverableBatches: [], errors: [] }

  const candidates = await opts.store.findOrphanedBatches({
    before: opts.before,
    limit: opts.limit,
  })
  const unrecoverableBatches = await opts.store.findUnrecoverableOrphanedBatches?.({
    before: opts.before,
    limit: opts.limit,
  }) ?? []
  let recovered = 0
  let onFinishDispatched = 0
  let onFinishFailed = 0
  let skipped = 0
  const batches: DurableBatchRecord[] = []
  const errors: Array<{ batchId: string, error: unknown }> = []

  for (const candidate of candidates) {
    const batch = await opts.store.finishOrphanedBatch(candidate.id, { now: opts.now })
    if (!batch) {
      skipped++
      continue
    }

    recovered++
    batches.push(batch)
    try {
      if (await fireOnFinishChain(opts.store, batch, opts.dispatchOnFinish))
        onFinishDispatched++
    }
    catch (error) {
      onFinishFailed++
      errors.push({ batchId: batch.id, error })
    }
  }

  return {
    scanned: candidates.length,
    recovered,
    onFinishDispatched,
    onFinishFailed,
    skipped,
    unrecoverable: unrecoverableBatches.length,
    batches,
    unrecoverableBatches,
    errors,
  }
}

/**
 * Settle one batch member. Decrements `pending_jobs`; only the settle that brings
 * the count to exactly 0 is the "winner" and runs `onFinish` (success **or**
 * failure both count as terminal, so a failing member still completes the batch).
 * Safe under concurrent settles — see {@link DurableBatchStore.decrementPending}.
 */
export async function settleBatchMember<
  Name extends string = string,
  Payload extends object = Record<string, unknown>,
  Queue extends string = string,
>(opts: SettleBatchMemberOptions<Name, Payload, Queue>): Promise<SettleBatchMemberResult> {
  const batchId = opts.batchId ?? (opts.jobId ? await opts.store.getJobBatchId(opts.jobId) : null)
  if (!batchId)
    return { batchComplete: false, onFinishDispatched: false }

  const batch = await opts.store.decrementPending(batchId, { failed: opts.failed })
  if (!batch)
    return { batchComplete: false, onFinishDispatched: false }

  const progress = toProgress(batch)
  if (batch.pendingJobs !== 0)
    return { batchComplete: false, onFinishDispatched: false, progress }

  const onFinishDispatched = await fireOnFinishChain(opts.store, batch, opts.dispatchOnFinish)
  return { batchComplete: true, onFinishDispatched, progress }
}

/**
 * Create an empty parent batch for grouping child batches. Children pass
 * `parentBatchId` to {@link createJobBatch}; the parent's `onFinish` fires once
 * every child batch has completed.
 */
export async function createParentJobBatch<
  Name extends string = string,
  Payload extends object = Record<string, unknown>,
  Queue extends string = string,
>(opts: {
  store: DurableBatchStore
  name?: string
  siteId?: string
  userId?: number
  allowFailures?: boolean
  onFinish?: DurableJobContinuation<Name, Payload, Queue>
  batchId?: string
}): Promise<string> {
  const batchId = opts.batchId ?? crypto.randomUUID()
  await opts.store.insertBatch({
    id: batchId,
    name: opts.name ?? null,
    totalJobs: 0,
    pendingJobs: 0,
    failedJobs: 0,
    onFinish: opts.onFinish ? serializeDurableJobContinuation(opts.onFinish) : null,
    allowFailures: opts.allowFailures ?? false,
    siteId: opts.siteId ?? null,
    userId: opts.userId ?? null,
  })
  return batchId
}

function orphanedBatchPredicate(
  batches: string,
  jobs: string,
  failedJobs: string,
  ageClause?: string,
  evidence: 'recoverable' | 'unrecoverable' = 'recoverable',
): string {
  const terminalEvidence = `((
      SELECT COUNT(*)
      FROM ${jobs}
      WHERE ${jobs}.batch_id = ${batches}.id
        AND ${jobs}.completed_at IS NOT NULL
    ) + (
      SELECT COUNT(*)
      FROM ${failedJobs}
      WHERE ${failedJobs}.batch_id = ${batches}.id
    ) + (
      SELECT COUNT(*)
      FROM ${batches} child_batches
      WHERE child_batches.parent_batch_id = ${batches}.id
        AND child_batches.finished_at IS NOT NULL
    ))`
  const clauses = [
    'pending_jobs > 0',
    'total_jobs > 0',
    'finished_at IS NULL',
    ageClause,
    `NOT EXISTS (
      SELECT 1
      FROM ${jobs}
      WHERE ${jobs}.batch_id = ${batches}.id
        AND ${jobs}.completed_at IS NULL
        AND ${jobs}.failed_at IS NULL
    )`,
    `NOT EXISTS (
      SELECT 1
      FROM ${batches} child_batches
      WHERE child_batches.parent_batch_id = ${batches}.id
        AND child_batches.finished_at IS NULL
    )`,
    `${terminalEvidence} ${evidence === 'recoverable' ? '>=' : '<'} total_jobs`,
  ].filter(Boolean)
  return clauses.join('\n          AND ')
}

async function all<T>(statement: { all?: <Result = T>() => Promise<{ results?: Result[] }> }): Promise<T[]> {
  const result = await statement.all?.<T>()
  return result?.results ?? []
}
