import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const cfJobBatches = sqliteTable('job_batches', {
  id: text('id').primaryKey(),
  name: text('name'),
  parentBatchId: text('parent_batch_id'),
  totalJobs: integer('total_jobs').notNull().default(0),
  pendingJobs: integer('pending_jobs').notNull().default(0),
  failedJobs: integer('failed_jobs').notNull().default(0),
  onFinish: text('on_finish'),
  handler: text('handler'),
  allowFailures: integer('allow_failures').default(0),
  siteId: text('site_id'),
  userId: integer('user_id'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
  finishedAt: integer('finished_at'),
}, t => [
  index('idx_job_batches_site').on(t.siteId),
  index('idx_job_batches_pending').on(t.pendingJobs),
  index('idx_job_batches_parent').on(t.parentBatchId),
  index('idx_job_batches_finished_at').on(t.finishedAt),
])

export const cfJobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  queue: text('queue').notNull(),
  jobType: text('job_type').notNull(),
  batchId: text('batch_id').references(() => cfJobBatches.id),
  userId: integer('user_id'),
  siteId: text('site_id'),
  partnerId: text('partner_id'),
  traceId: text('trace_id'),
  uniqueKey: text('unique_key'),
  payload: text('payload').notNull(),
  attempts: integer('attempts').default(0),
  maxAttempts: integer('max_attempts').default(3),
  reservedAt: integer('reserved_at'),
  availableAt: integer('available_at').notNull(),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  completedAt: integer('completed_at'),
  failedAt: integer('failed_at'),
  lastError: text('last_error'),
  retryReasons: text('retry_reasons'),
  rowsFetched: integer('rows_fetched'),
  rowsInserted: integer('rows_inserted'),
  d1RowsRead: integer('d1_rows_read'),
  d1RowsWritten: integer('d1_rows_written'),
  durationMs: integer('duration_ms'),
}, t => [
  index('idx_jobs_claimable').on(t.queue, t.reservedAt, t.availableAt),
  index('idx_jobs_dispatchable').on(t.availableAt).where(sql`reserved_at IS NULL AND completed_at IS NULL AND failed_at IS NULL`),
  index('idx_jobs_stale_reserved').on(t.reservedAt).where(sql`reserved_at IS NOT NULL AND completed_at IS NULL AND failed_at IS NULL`),
  index('idx_jobs_user').on(t.userId),
  index('idx_jobs_site').on(t.siteId),
  index('idx_jobs_partner').on(t.partnerId),
  index('idx_jobs_type').on(t.jobType),
  index('idx_jobs_batch').on(t.batchId),
  index('idx_jobs_trace').on(t.traceId),
  index('idx_jobs_sync_dedup').on(t.siteId, t.jobType),
  index('idx_jobs_completed_at').on(t.completedAt).where(sql`completed_at IS NOT NULL`),
  uniqueIndex('idx_jobs_unique_active').on(t.uniqueKey).where(sql`unique_key IS NOT NULL AND completed_at IS NULL AND failed_at IS NULL`),
])

export const cfFailedJobs = sqliteTable('failed_jobs', {
  id: text('id').primaryKey(),
  queue: text('queue').notNull(),
  jobType: text('job_type').notNull(),
  batchId: text('batch_id'),
  userId: integer('user_id'),
  siteId: text('site_id'),
  partnerId: text('partner_id'),
  traceId: text('trace_id'),
  uniqueKey: text('unique_key'),
  payload: text('payload').notNull(),
  exception: text('exception').notNull(),
  attempts: integer('attempts').notNull(),
  maxAttempts: integer('max_attempts').notNull(),
  failedAt: integer('failed_at').notNull(),
}, t => [
  index('idx_failed_jobs_queue').on(t.queue),
  index('idx_failed_jobs_site').on(t.siteId),
  index('idx_failed_jobs_trace').on(t.traceId),
  index('idx_failed_jobs_batch').on(t.batchId),
  index('idx_failed_jobs_failed_at').on(t.failedAt),
])

export type CfJobBatchInsert = typeof cfJobBatches.$inferInsert
export type CfJobBatchSelect = typeof cfJobBatches.$inferSelect
export type CfJobInsert = typeof cfJobs.$inferInsert
export type CfJobSelect = typeof cfJobs.$inferSelect
export type CfFailedJobInsert = typeof cfFailedJobs.$inferInsert
export type CfFailedJobSelect = typeof cfFailedJobs.$inferSelect
