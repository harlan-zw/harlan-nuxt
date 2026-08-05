/** Framework-neutral durable outbox surface for adapters and caller-owned D1 transactions. */
export {
  buildD1DurableJobPublicationUpgradeSql,
  createD1DurableJobRepository,
  d1DurableJobMigrationSql,
  stagePreparedDurableJobs,
} from './d1'
export type {
  D1DatabaseLike,
  D1DurableJobRepository,
  D1PreparedDurableJobStage,
  D1PreparedStatementLike,
  PrepareD1DurableJobStageError,
  StageD1DurableJobsResult,
} from './d1'
export {
  prepareDurableJob,
  prepareDurableJobResult,
  publishDurableJobBatch,
} from './outbox'
export type {
  DurableJobPublicationRepository,
  DurableJobRecord,
  PrepareDurableJobOptions,
  PublishDurableJobBatchResult,
  QueuePublisher,
} from './outbox'
export type { Result } from './result'
