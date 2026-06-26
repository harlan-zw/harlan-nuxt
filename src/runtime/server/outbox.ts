import type { JobError } from './errors'
import type { SendBackpressureOptions } from './queue'
import type { AnyJobDefinition, JobNameOf, JobPayloadByName, JobQueueByName } from './registry'
import type { Result } from './result'
import type {
  CloudflareQueue,
  DispatchableJob,
  DispatchResult,
  JobContext,
  JobControlResult,
  JobDefinition,
  JobHandler,
  JobRunStats,
  QueueMessage,
  QueueSendOptions,
} from './types'
import { dispatchRegisteredJob } from './dispatch'
import { describeCause, formatJobError, jobErrors, jobErrorToException } from './errors'
import { buildJobPayload } from './payload'
import { createJobTraceId, createJobUniqueKey, resolveJobMaxAttempts } from './policy'
import { CF_QUEUE_MAX_MESSAGE_BYTES, sendBatchChunked, withSendBackpressure } from './queue'
import { parseJobInput } from './registry'
import { err, ok, unwrapResult } from './result'

function byteLength(value: string): number {
  return typeof Buffer !== 'undefined' ? Buffer.byteLength(value, 'utf8') : new TextEncoder().encode(value).byteLength
}

export interface DurableJobRoute<Queue extends string = string> {
  queue: Queue
  jobType: string
}

export interface DurableJobRecord<Queue extends string = string> {
  id: string
  queue: Queue
  jobType: string
  batchId?: string
  userId?: number
  siteId?: string
  partnerId?: string
  traceId: string
  uniqueKey?: string
  payload: string
  attempts: number
  maxAttempts: number
  availableAt: number
  createdAt: number
}

export interface QueueJobMessage<Queue extends string = string> {
  jobId: string
  queue: Queue
}

export type DurableJobContinuationStage = 'then' | 'catch' | 'finally'

export interface DurableJobContinuation<
  Name extends string = string,
  Payload extends object = Record<string, unknown>,
  Queue extends string = string,
> {
  name: Name
  payload: Payload
  queue?: Queue
  delaySeconds?: number
}

export type DurableJobContinuations<
  Name extends string = string,
  Payload extends object = Record<string, unknown>,
  Queue extends string = string,
> = Partial<Record<DurableJobContinuationStage, Array<DurableJobContinuation<Name, Payload, Queue>>>>

export interface DurableJobRepository<
  Queue extends string = string,
  Record extends DurableJobRecord<Queue> = DurableJobRecord<Queue>,
> {
  insertJob: (record: Record) => Promise<boolean>
  /**
   * Optional batched insert. When implemented, callers can persist many records in chunks
   * (chunked at the D1 100-statement limit by D1-backed implementations).
   */
  insertJobs?: (records: readonly Record[], opts?: { batchSize?: number }) => Promise<{ inserted: Record[], chunks: Array<{ ok: boolean, ids: string[], changes: number, error?: unknown }> }>
}

export interface RecordDurableJobFailureInput<Queue extends string = string> {
  id?: string
  queue: Queue | string
  jobType: string
  batchId?: string | null
  userId?: number | null
  siteId?: string | null
  partnerId?: string | null
  traceId?: string | null
  uniqueKey?: string | null
  payload: string
  exception: string
  attempts: number
  maxAttempts?: number
}

/**
 * Persists a failure record without claiming or deleting a `jobs` row.
 * Used by the DLQ helper to log exhausted messages whose original job rows may not exist
 * (e.g. lightweight queue path) or whose lifecycle has already been finalized.
 */
export interface DurableJobFailureRepository {
  recordFailure: (input: RecordDurableJobFailureInput) => Promise<void>
}

export interface DurableJobRegistryLike<Env = unknown, Db = unknown, Logger = unknown> {
  /** May resolve asynchronously for lazily-loaded jobs. Unused on the producer path. */
  getHandler?: (name: string) => JobHandler<unknown, Env, Db, Logger> | undefined | Promise<JobHandler<unknown, Env, Db, Logger> | undefined>
  getJobDefinition?: (name: string) => JobDefinition<string, unknown, string, Env, Db, Logger> | undefined
  getJobRoute?: (name: string) => DurableJobRoute<string> | undefined
}

export interface TypedDurableJobRegistryLike<Jobs extends readonly AnyJobDefinition[]> extends DurableJobRegistryLike {
  jobs: Jobs
}

export type DurableJobClaimMiss = 'already-resolved' | 'in-flight' | 'not-found'

export type DurableJobClaimResult<Job>
  = | { status: 'claimed', job: Job }
    | { status: DurableJobClaimMiss }

export interface ReleaseDurableJobOptions {
  delaySeconds?: number
  availableAt?: number
  error?: string
}

export interface DurableJobLifecycle<
  Job,
  CompleteResult = void,
  FailOptions = unknown,
  ReleaseResult = void,
> {
  claimJob: (id: string) => Promise<Job | null>
  resolveClaimMiss?: (id: string) => Promise<DurableJobClaimMiss>
  completeJob: (job: Job, result?: unknown) => Promise<CompleteResult>
  failJob: (job: Job, error: string, opts?: FailOptions) => Promise<void>
  releaseJob?: (job: Job, opts?: ReleaseDurableJobOptions) => Promise<ReleaseResult>
}

export interface QueuePublisher<
  Queue extends string = string,
  Message extends QueueJobMessage<Queue> = QueueJobMessage<Queue>,
> {
  send: (queue: Queue, message: Message, opts?: QueueSendOptions & SendBackpressureOptions) => Promise<boolean>
  sendBatch: (queue: Queue, messages: Message[], opts?: QueueSendOptions & SendBackpressureOptions) => Promise<boolean>
}

export interface DurableJobRecoveryQuery {
  now?: number
  /** Only return jobs created at or before this unix-second timestamp. */
  createdBefore?: number
  limit?: number
}

export interface DurableJobStaleRecoveryQuery extends DurableJobRecoveryQuery {
  staleBefore: number
  availableAt?: number
  error?: string
}

export interface DurableJobRecoveryRepository<
  Queue extends string = string,
  Record extends Pick<DurableJobRecord<Queue>, 'id' | 'queue'> = Pick<DurableJobRecord<Queue>, 'id' | 'queue'>,
> {
  findDispatchableJobs?: (query?: DurableJobRecoveryQuery) => Promise<Record[]>
  findStaleReservedJobs?: (query: DurableJobStaleRecoveryQuery) => Promise<Record[]>
  releaseStaleReservedJobs?: (query: DurableJobStaleRecoveryQuery) => Promise<number>
  /**
   * Terminally fail stale-reserved jobs that have already exhausted their
   * attempts (`attempts >= max_attempts`), moving them to `failed_jobs` instead
   * of leaving them to be re-released forever. Returns the number terminalized.
   * Optional so older repositories degrade to the prior (revive-only) behaviour.
   */
  failStaleReservedJobs?: (query: DurableJobStaleRecoveryQuery) => Promise<number>
}

export interface PruneDurableJobsQuery {
  /** Unix-seconds cutoff: terminal rows with a timestamp at or before this are deleted. */
  before: number
  /**
   * Max rows deleted per statement. Implementations chunk the delete in a loop
   * (D1 caps rows touched per statement), so the full backlog older than `before`
   * is removed regardless of this value. Defaults to the implementation's chunk size.
   */
  limit?: number
}

/**
 * Pruning the three terminal-row tables (Laravel `queue:prune-batches` /
 * `queue:prune-failed` parity). Each method deletes only rows that are genuinely
 * terminal (completed / failed / finished) and older than `before`, returning the
 * total deleted. In-flight rows (`completed_at`/`failed_at`/`finished_at` IS NULL)
 * are never touched.
 */
export interface DurableJobPruneRepository {
  /** Delete `jobs` rows with `completed_at <= before` (soft-completed, kept for observability). */
  pruneCompletedJobs: (query: PruneDurableJobsQuery) => Promise<number>
  /** Delete `job_batches` rows with `finished_at <= before` (terminal batches). */
  pruneFinishedBatches: (query: PruneDurableJobsQuery) => Promise<number>
  /** Delete `failed_jobs` rows with `failed_at <= before`. */
  pruneFailedJobs: (query: PruneDurableJobsQuery) => Promise<number>
}

export interface PruneDurableJobsOptions {
  /** Cutoff for `completeJob`-soft-completed `jobs` rows. Omit to skip. */
  completedBefore?: number
  /** Cutoff for terminal `job_batches` rows. Omit to skip. */
  finishedBatchesBefore?: number
  /** Cutoff for `failed_jobs` rows. Omit to skip. */
  failedBefore?: number
  /** Per-statement chunk size forwarded to each prune method. */
  limit?: number
}

export interface PruneDurableJobsResult {
  completedJobs: number
  finishedBatches: number
  failedJobs: number
}

/**
 * Convenience over {@link DurableJobPruneRepository} that prunes all three tables
 * with independent cutoffs. Ordering matters: `jobs.batch_id` FKs `job_batches(id)`,
 * so member jobs (completed + failed) are pruned BEFORE their batches — otherwise a
 * batch delete can violate the FK where D1 enforces it. A cutoff left `undefined`
 * skips that table (the corresponding count is 0).
 */
export async function pruneDurableJobs(
  repository: DurableJobPruneRepository,
  opts: PruneDurableJobsOptions,
): Promise<PruneDurableJobsResult> {
  const completedJobs = typeof opts.completedBefore === 'number'
    ? await repository.pruneCompletedJobs({ before: opts.completedBefore, limit: opts.limit })
    : 0
  const failedJobs = typeof opts.failedBefore === 'number'
    ? await repository.pruneFailedJobs({ before: opts.failedBefore, limit: opts.limit })
    : 0
  const finishedBatches = typeof opts.finishedBatchesBefore === 'number'
    ? await repository.pruneFinishedBatches({ before: opts.finishedBatchesBefore, limit: opts.limit })
    : 0
  return { completedJobs, failedJobs, finishedBatches }
}

export interface PrepareDurableJobOptions<
  Name extends string,
  Payload extends object,
  Queue extends string,
> {
  name: Name
  payload: Payload
  route?: DurableJobRoute<Queue>
  registry?: DurableJobRegistryLike
  definition?: Pick<JobDefinition<Name, Payload, Queue, unknown, unknown, unknown>, 'name' | 'queue' | 'jobType' | 'input' | 'tries' | 'maxAttempts' | 'unique' | 'uniqueId'>
  id?: string
  batchId?: string
  userId?: number
  siteId?: string
  partnerId?: string
  delaySeconds?: number
  now?: number
  traceId?: string
  defaultMaxAttempts?: number
  continuations?: DurableJobContinuations<string, Record<string, unknown>, Queue>
}

/**
 * Errors-as-values core: builds a durable outbox record or returns a typed
 * `JobError` for every modelled failure (bad payload, unroutable task, oversized
 * message, invalid continuation). `prepareDurableJob` is the throwing wrapper over
 * this for call sites that prefer exceptions.
 */
export async function prepareDurableJobResult<
  const Name extends string,
  Payload extends object,
  Queue extends string,
>(opts: PrepareDurableJobOptions<Name, Payload, Queue>): Promise<Result<DurableJobRecord<Queue>, JobError>> {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const definition = opts.definition ?? opts.registry?.getJobDefinition?.(opts.name) as Pick<JobDefinition<Name, Payload, Queue, unknown, unknown, unknown>, 'name' | 'queue' | 'jobType' | 'input' | 'tries' | 'maxAttempts' | 'unique' | 'uniqueId'> | undefined

  const route = resolveDurableJobRoute(opts.name, opts.route, definition, opts.registry)
  if (!route)
    return err(jobErrors.noRoute(opts.name))

  const parsedPayload = parseJobInput(definition as never, opts.payload)
  if (!parsedPayload.success)
    return err(jobErrors.invalidPayload(opts.name, parsedPayload.error))

  const continuations = normalizeDurableJobContinuations(opts.continuations)
  const continuationError = validateDurableJobContinuations(opts.registry, continuations)
  if (continuationError)
    return err(continuationError)

  const uniqueKey = definition?.unique
    ? await createJobUniqueKey(opts.name, parsedPayload.data, definition.uniqueId as never)
    : undefined
  const payload = buildJobPayload(opts.name, parsedPayload.data as Payload)
  const serialized = JSON.stringify(continuations ? { ...payload, _continuations: continuations } : payload)
  const bytes = byteLength(serialized)
  if (bytes > CF_QUEUE_MAX_MESSAGE_BYTES)
    return err(jobErrors.payloadTooLarge(opts.name, bytes, CF_QUEUE_MAX_MESSAGE_BYTES))

  return ok({
    id: opts.id ?? crypto.randomUUID(),
    queue: route.queue as Queue,
    jobType: route.jobType,
    batchId: opts.batchId,
    userId: opts.userId,
    siteId: opts.siteId,
    partnerId: opts.partnerId,
    traceId: opts.traceId ?? createJobTraceId(),
    uniqueKey,
    payload: serialized,
    attempts: 0,
    maxAttempts: resolveJobMaxAttempts(definition) ?? opts.defaultMaxAttempts ?? 3,
    availableAt: now + (opts.delaySeconds ?? 0),
    createdAt: now,
  })
}

export async function prepareDurableJob<
  const Name extends string,
  Payload extends object,
  Queue extends string,
>(opts: PrepareDurableJobOptions<Name, Payload, Queue>): Promise<DurableJobRecord<Queue>> {
  return unwrapResult(await prepareDurableJobResult(opts), jobErrorToException)
}

export async function prepareRegisteredDurableJob<
  const Jobs extends readonly AnyJobDefinition[],
  const Name extends JobNameOf<Jobs>,
>(
  registry: TypedDurableJobRegistryLike<Jobs>,
  opts: PrepareRegisteredDurableJobOptions<Jobs, Name>,
): Promise<DurableJobRecord<JobQueueByName<Jobs, Name>>> {
  return prepareDurableJob({
    ...opts,
    registry,
  })
}

export type PrepareRegisteredDurableJobOptions<
  Jobs extends readonly AnyJobDefinition[],
  Name extends JobNameOf<Jobs>,
> = Omit<PrepareDurableJobOptions<Name, JobPayloadByName<Jobs, Name> & object, JobQueueByName<Jobs, Name>>, 'registry' | 'definition' | 'route' | 'name' | 'payload'> & {
  name: Name
  payload: JobPayloadByName<Jobs, Name> & object
  route?: DurableJobRoute<JobQueueByName<Jobs, Name>>
}

function resolveDurableJobRoute<
  Name extends string,
  Payload extends object,
  Queue extends string,
>(
  name: Name,
  route: DurableJobRoute<Queue> | undefined,
  definition: Pick<JobDefinition<Name, Payload, Queue, unknown, unknown, unknown>, 'name' | 'queue' | 'jobType'> | undefined,
  registry: DurableJobRegistryLike | undefined,
): DurableJobRoute<Queue | string> | undefined {
  if (route)
    return route

  const registeredRoute = registry?.getJobRoute?.(name)
  if (registeredRoute)
    return registeredRoute

  if (definition)
    return { queue: definition.queue, jobType: definition.jobType ?? definition.name }

  return undefined
}

export function normalizeDurableJobContinuations<
  Name extends string = string,
  Payload extends object = Record<string, unknown>,
  Queue extends string = string,
>(
  continuations?: DurableJobContinuations<Name, Payload, Queue>,
): DurableJobContinuations<Name, Payload, Queue> | undefined {
  if (!continuations)
    return undefined

  const normalized: DurableJobContinuations<Name, Payload, Queue> = {}
  for (const stage of ['then', 'catch', 'finally'] as const) {
    const entries = continuations[stage]?.filter(Boolean)
    if (entries?.length)
      normalized[stage] = entries
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

/**
 * Validates continuations against the registry, returning the first `JobError`
 * found or `undefined` when they are all routable and well-typed.
 */
export function validateDurableJobContinuations(
  registry: DurableJobRegistryLike | undefined,
  continuations: DurableJobContinuations<string, Record<string, unknown>, string> | undefined,
): JobError | undefined {
  if (!registry || !continuations)
    return undefined

  for (const stage of ['then', 'catch', 'finally'] as const) {
    for (const continuation of continuations[stage] ?? []) {
      const definition = registry.getJobDefinition?.(continuation.name)
      if (!definition)
        return jobErrors.unknownContinuation(continuation.name)

      const parsed = parseJobInput(definition, continuation.payload)
      if (!parsed.success)
        return jobErrors.invalidContinuation(continuation.name, parsed.error)

      if (continuation.queue && definition.queue !== continuation.queue)
        return jobErrors.continuationQueueMismatch(continuation.name, definition.queue, continuation.queue)
    }
  }

  return undefined
}

export function getDurableJobContinuations<
  Name extends string = string,
  Payload extends object = Record<string, unknown>,
  Queue extends string = string,
>(
  payload: unknown,
): DurableJobContinuations<Name, Payload, Queue> | undefined {
  if (!payload || typeof payload !== 'object')
    return undefined

  return normalizeDurableJobContinuations(
    (payload as { _continuations?: DurableJobContinuations<Name, Payload, Queue> })._continuations,
  )
}

export function getDurableJobContinuationsForStage<
  Name extends string = string,
  Payload extends object = Record<string, unknown>,
  Queue extends string = string,
>(
  payload: unknown,
  stage: DurableJobContinuationStage,
): Array<DurableJobContinuation<Name, Payload, Queue>> {
  return getDurableJobContinuations<Name, Payload, Queue>(payload)?.[stage] ?? []
}

export function serializeDurableJobContinuation<
  Name extends string,
  Payload extends object,
  Queue extends string = string,
>(continuation: DurableJobContinuation<Name, Payload, Queue>): string {
  return JSON.stringify(continuation)
}

export function parseDurableJobContinuation<
  Name extends string = string,
  Payload extends object = Record<string, unknown>,
  Queue extends string = string,
>(value: string): DurableJobContinuation<Name, Payload, Queue> {
  const parsed = JSON.parse(value) as DurableJobContinuation<Name, Payload, Queue>
  if (!parsed || typeof parsed.name !== 'string' || !parsed.payload || typeof parsed.payload !== 'object')
    throw new Error('Invalid durable job continuation')
  return parsed
}

export async function dispatchDurableJobContinuations<
  Name extends string,
  Payload extends object,
  Queue extends string = string,
>(
  continuations: Array<DurableJobContinuation<Name, Payload, Queue>>,
  dispatch: (continuation: DurableJobContinuation<Name, Payload, Queue>) => Promise<void>,
): Promise<void> {
  await Promise.all(continuations.map(continuation => dispatch(continuation)))
}

export function toQueueJobMessage<Queue extends string>(record: Pick<DurableJobRecord<Queue>, 'id' | 'queue'>): QueueJobMessage<Queue> {
  return { jobId: record.id, queue: record.queue }
}

export function groupQueueJobMessagesByQueue<Queue extends string>(
  records: Array<Pick<DurableJobRecord<Queue>, 'id' | 'queue'>>,
): Map<Queue, Array<QueueJobMessage<Queue>>> {
  const groups = new Map<Queue, Array<QueueJobMessage<Queue>>>()
  for (const record of records) {
    const messages = groups.get(record.queue) ?? []
    messages.push(toQueueJobMessage(record))
    groups.set(record.queue, messages)
  }
  return groups
}

export function createQueuePublisher<
  Env extends Record<string, unknown>,
  Queue extends string,
  Message extends QueueJobMessage<Queue> = QueueJobMessage<Queue>,
>(
  env: Env,
  resolveBinding: (queue: Queue) => string | undefined,
  opts: { onMissingBinding?: (queue: Queue, count: number) => void | Promise<void> } = {},
): QueuePublisher<Queue, Message> {
  function getBinding(queue: Queue): CloudflareQueue<Message> | undefined {
    const binding = resolveBinding(queue)
    if (!binding)
      return undefined
    const cfQueue = env[binding] as CloudflareQueue<Message> | undefined
    return cfQueue && typeof cfQueue.send === 'function' ? cfQueue : undefined
  }

  return {
    async send(queue, message, sendOpts) {
      const cfQueue = getBinding(queue)
      if (!cfQueue) {
        await opts.onMissingBinding?.(queue, 1)
        return false
      }
      await withSendBackpressure(() => cfQueue.send(message, sendOpts), sendOpts)
      return true
    },
    async sendBatch(queue, messages, sendOpts) {
      if (messages.length === 0)
        return true

      const cfQueue = getBinding(queue)
      if (!cfQueue) {
        await opts.onMissingBinding?.(queue, messages.length)
        return false
      }

      await sendBatchChunked(cfQueue, messages, sendOpts)
      return true
    },
  }
}

export async function claimDurableJob<Job>(
  lifecycle: Pick<DurableJobLifecycle<Job>, 'claimJob' | 'resolveClaimMiss'>,
  id: string,
): Promise<DurableJobClaimResult<Job>> {
  const job = await lifecycle.claimJob(id)
  if (job)
    return { status: 'claimed', job }

  return {
    status: lifecycle.resolveClaimMiss
      ? await lifecycle.resolveClaimMiss(id)
      : 'not-found',
  }
}

export async function completeDurableJob<Job, CompleteResult>(
  lifecycle: Pick<DurableJobLifecycle<Job, CompleteResult>, 'completeJob'>,
  job: Job,
  result?: unknown,
): Promise<CompleteResult> {
  return await lifecycle.completeJob(job, result)
}

export async function failDurableJob<Job, FailOptions>(
  lifecycle: Pick<DurableJobLifecycle<Job, unknown, FailOptions>, 'failJob'>,
  job: Job,
  error: string,
  opts?: FailOptions,
): Promise<void> {
  await lifecycle.failJob(job, error, opts)
}

export async function releaseDurableJob<Job, ReleaseResult>(
  lifecycle: Pick<DurableJobLifecycle<Job, unknown, unknown, ReleaseResult>, 'releaseJob'>,
  job: Job,
  opts?: ReleaseDurableJobOptions,
): Promise<ReleaseResult | undefined> {
  return await lifecycle.releaseJob?.(job, opts)
}

export async function findDispatchableDurableJobs<
  Queue extends string,
  Record extends Pick<DurableJobRecord<Queue>, 'id' | 'queue'>,
>(
  repository: Pick<DurableJobRecoveryRepository<Queue, Record>, 'findDispatchableJobs'>,
  query?: DurableJobRecoveryQuery,
): Promise<Record[]> {
  return await repository.findDispatchableJobs?.(query) ?? []
}

export async function releaseStaleReservedDurableJobs<
  Queue extends string,
  Record extends Pick<DurableJobRecord<Queue>, 'id' | 'queue'>,
>(
  repository: Pick<DurableJobRecoveryRepository<Queue, Record>, 'releaseStaleReservedJobs'>,
  query: DurableJobStaleRecoveryQuery,
): Promise<number> {
  return await repository.releaseStaleReservedJobs?.(query) ?? 0
}

export async function failStaleReservedDurableJobs<
  Queue extends string,
  Record extends Pick<DurableJobRecord<Queue>, 'id' | 'queue'>,
>(
  repository: Pick<DurableJobRecoveryRepository<Queue, Record>, 'failStaleReservedJobs'>,
  query: DurableJobStaleRecoveryQuery,
): Promise<number> {
  return await repository.failStaleReservedJobs?.(query) ?? 0
}

/**
 * Outcome of {@link enqueueDurableJob}, discriminated on `status` so the three
 * reachable states are explicit and the impossible ones (e.g. "not inserted but
 * dispatched") are unrepresentable:
 * - `enqueued`: row persisted and the queue message was sent.
 * - `duplicate`: `insertJob` reported the row already existed (unique conflict);
 *   nothing was dispatched.
 * - `not-dispatched`: row persisted but the queue binding was missing, so the send
 *   was skipped (no throw). The row is durable; an outbox sweep will redispatch it.
 * - `dispatch-failed`: row persisted but the queue send threw. Also recoverable via
 *   a sweep; `cause` is the raw (infra) throw.
 */
export type EnqueueDurableJobResult
  = | { status: 'enqueued' }
    | { status: 'duplicate' }
    | { status: 'not-dispatched' }
    | { status: 'dispatch-failed', cause: unknown }

export async function enqueueDurableJob<
  Queue extends string,
  Record extends DurableJobRecord<Queue>,
>(
  repository: Pick<DurableJobRepository<Queue, Record>, 'insertJob'>,
  publisher: Pick<QueuePublisher<Queue>, 'send'>,
  record: Record,
  opts?: { delaySeconds?: number },
): Promise<EnqueueDurableJobResult> {
  const inserted = await repository.insertJob(record)
  if (!inserted)
    return { status: 'duplicate' }

  return await publisher
    .send(record.queue, toQueueJobMessage(record), opts)
    .then((sent): EnqueueDurableJobResult => sent ? { status: 'enqueued' } : { status: 'not-dispatched' })
    .catch((cause: unknown): EnqueueDurableJobResult => ({ status: 'dispatch-failed', cause }))
}

/**
 * Per-queue outcome of a durable batch dispatch, discriminated on `status`:
 * - `sent`: the queue accepted the batch.
 * - `not-dispatched`: the queue binding was missing, so the send was skipped (no
 *   throw); the rows are durable and a sweep will redispatch them.
 * - `failed`: the send threw; `cause` is the raw (infra) throw. Also sweep-recoverable.
 */
export type DispatchDurableJobBatchResult<Queue extends string = string>
  = | { queue: Queue, status: 'sent' }
    | { queue: Queue, status: 'not-dispatched' }
    | { queue: Queue, status: 'failed', cause: unknown }

export interface SweepDurableJobsResult<Queue extends string> {
  swept: number
  dispatched: Array<DispatchDurableJobBatchResult<Queue>>
}

export async function sweepDispatchableDurableJobs<Queue extends string>(
  repository: Pick<DurableJobRecoveryRepository<Queue, Pick<DurableJobRecord<Queue>, 'id' | 'queue'>>, 'findDispatchableJobs'>,
  publisher: Pick<QueuePublisher<Queue>, 'sendBatch'>,
  query?: DurableJobRecoveryQuery,
): Promise<SweepDurableJobsResult<Queue>> {
  const records = await findDispatchableDurableJobs(repository, query)
  if (records.length === 0)
    return { swept: 0, dispatched: [] }
  const dispatched = await dispatchDurableJobBatch(publisher, records)
  return { swept: records.length, dispatched }
}

export async function dispatchDurableJobBatch<Queue extends string>(
  publisher: Pick<QueuePublisher<Queue>, 'sendBatch'>,
  records: Array<Pick<DurableJobRecord<Queue>, 'id' | 'queue'>>,
  opts?: { delaySeconds?: number },
): Promise<Array<DispatchDurableJobBatchResult<Queue>>> {
  const groups = groupQueueJobMessagesByQueue(records)
  return await Promise.all(
    [...groups].map(async ([queue, messages]): Promise<DispatchDurableJobBatchResult<Queue>> => {
      try {
        const sent = await publisher.sendBatch(queue, messages, opts)
        return sent ? { queue, status: 'sent' } : { queue, status: 'not-dispatched' }
      }
      catch (cause) {
        return { queue, status: 'failed', cause }
      }
    }),
  )
}

export type DurableJobMessageStatus
  = | 'invalid-message'
    | DurableJobClaimMiss
    | 'dispatch-failed'
    | 'released'
    | 'failed'
    | 'completed'
    | 'errored'

export interface RunDurableJobMessageOptions<
  StoredJob,
  Job extends DispatchableJob,
  Message extends QueueJobMessage = QueueJobMessage,
  Env = unknown,
  Db = unknown,
  Logger = unknown,
  CompleteResult = unknown,
  FailOptions = unknown,
> {
  message: Pick<QueueMessage<Message>, 'body' | 'ack' | 'retry'>
  lifecycle: Pick<DurableJobLifecycle<StoredJob, CompleteResult, FailOptions>, 'claimJob' | 'resolveClaimMiss' | 'completeJob' | 'failJob' | 'releaseJob'>
  registry: {
    getHandler: (name: string) => JobHandler<unknown, Env, Db, Logger> | undefined | Promise<JobHandler<unknown, Env, Db, Logger> | undefined>
    getJobDefinition?: (name: string) => JobDefinition<string, unknown, string, Env, Db, Logger> | undefined
  }
  toDispatchableJob: (job: StoredJob) => Job
  createJobContext: (input: {
    job: Job
    storedJob: StoredJob
    taskName: string
    payload: Record<string, unknown>
    control: JobControlResult
  }) => JobContext<Env, Db, Logger> | Promise<JobContext<Env, Db, Logger>>
  // (registry.getHandler below may resolve async for lazily-loaded jobs;
  // dispatchRegisteredJob awaits it.)
  getJobId?: (message: Message) => string | undefined
  retryDelaySeconds?: number | ((input: { error: unknown, job: StoredJob }) => number)
  failDispatchFailure?: boolean
  completeResult?: (input: { job: StoredJob, dispatch: DispatchResult }) => unknown | Promise<unknown>
  /**
   * Laravel worker model: a handler that throws is retried until `attempts`
   * reaches the job's max, then failed (→ `failed_jobs`) instead of released for
   * another try. Supply this to read the stored job's max so the consumer — not
   * just the queue transport's `max_retries` — enforces the per-job attempt cap.
   * Omit to keep retrying every throw (the transport/DLQ then decides terminal).
   */
  maxAttemptsOf?: (job: StoredJob) => number | undefined
  /**
   * Per-job scope created right after claim: `wrapDispatch` wraps the handler run
   * (e.g. AsyncLocalStorage telemetry), `onSettled` observes every terminal/
   * released outcome (e.g. write a run-log row). Both close over the same scope so
   * the wrapper's collected data is available to the observer.
   */
  createJobScope?: (storedJob: StoredJob) => DurableJobScope<StoredJob>
  /**
   * Decide whether a THROWN error is terminal (→ `failed_jobs`) vs released for
   * retry. Overrides the default `attempts >= maxAttemptsOf` so callers can, e.g.,
   * never fail on transient infra errors. `maxAttempts` is `maxAttemptsOf`'s value.
   */
  isPermanentFailure?: (input: { error: unknown, storedJob: StoredJob, attempts: number, maxAttempts: number | undefined }) => boolean
  /**
   * Dispatch the job payload's `then`/`catch`/`finally` continuations after a
   * terminal outcome: `then`+`finally` on success, `catch`+`finally` on terminal
   * failure, none on a release/retry.
   */
  dispatchContinuations?: (input: { storedJob: StoredJob, stage: DurableJobContinuationStage }) => void | Promise<void>
}

export interface DurableJobSettlement<StoredJob> {
  storedJob: StoredJob
  status: RunDurableJobMessageResult['status']
  /** Wall-clock ms from claim to settle. */
  durationMs: number
  /** True when the job reached a terminal failure (not a release/retry). */
  permanent: boolean
  /** The error for failed/released/exhausted outcomes (raw, for the caller to classify). */
  error?: unknown
}

export interface DurableJobScope<StoredJob> {
  wrapDispatch?: (run: () => Promise<DispatchResult>) => Promise<DispatchResult>
  onSettled?: (settlement: DurableJobSettlement<StoredJob>) => void | Promise<void>
}

/**
 * Outcome of {@link runDurableJobMessage}, discriminated on `status` so each
 * variant carries exactly the data it can produce:
 * - claim phase: `invalid-message` (no job id) or a `DurableJobClaimMiss`
 *   (`already-resolved` / `in-flight` / `not-found`) — no dispatch happened.
 * - `dispatch-failed`: the handler could not run; `error` is the typed `JobError`.
 * - `failed` / `released`: the handler ran and called `ctx.fail()` / `ctx.release()`.
 * - `completed`: the handler ran to completion.
 * - `errored`: the handler threw an unexpected defect; the message is retried and
 *   `error` carries the defect as a `handler-threw` `JobError` (`error.cause` is the
 *   original throw). Distinct from `released` (a deliberate `ctx.release()`).
 * - `exhausted`: the handler threw AND `attempts` reached `maxAttemptsOf` — the job
 *   was failed (→ `failed_jobs`) rather than retried. Terminal.
 */
export type RunDurableJobMessageResult
  = | { status: 'invalid-message' }
    | { status: DurableJobClaimMiss }
    | { status: 'dispatch-failed', dispatch: DispatchResult, error?: JobError }
    | { status: 'failed', dispatch: DispatchResult }
    | { status: 'released', dispatch: DispatchResult }
    | { status: 'completed', dispatch: DispatchResult }
    | { status: 'errored', error: JobError }
    | { status: 'exhausted', error: JobError }

export async function runDurableJobMessage<
  StoredJob,
  Job extends DispatchableJob,
  Message extends QueueJobMessage = QueueJobMessage,
  Env = unknown,
  Db = unknown,
  Logger = unknown,
  CompleteResult = unknown,
  FailOptions = unknown,
>(
  opts: RunDurableJobMessageOptions<StoredJob, Job, Message, Env, Db, Logger, CompleteResult, FailOptions>,
): Promise<RunDurableJobMessageResult> {
  const jobId = opts.getJobId?.(opts.message.body) ?? opts.message.body.jobId
  if (!jobId) {
    opts.message.ack()
    return { status: 'invalid-message' }
  }

  const claimed = await claimDurableJob(opts.lifecycle, jobId)
  if (claimed.status !== 'claimed') {
    if (claimed.status === 'in-flight')
      opts.message.retry({ delaySeconds: 60 })
    else
      opts.message.ack()
    return { status: claimed.status }
  }

  const storedJob = claimed.job
  const job = opts.toDispatchableJob(storedJob)

  // Accumulate handler-reported execution stats (ctx.reportStats); merged into
  // the completeJob result so they reach the row + the metrics sink. Summed so
  // repeated calls add up.
  const reportedStats: JobRunStats = {}
  const reportStats = (s: JobRunStats): void => {
    for (const k of ['rowsFetched', 'rowsInserted', 'd1RowsRead', 'd1RowsWritten'] as const) {
      if (typeof s[k] === 'number')
        reportedStats[k] = (reportedStats[k] ?? 0) + s[k]!
    }
  }

  // Per-job scope (telemetry wrapper + settlement observer) + wall-clock timing.
  const scope = opts.createJobScope?.(storedJob)
  const startedMs = Date.now()
  const settle = async (status: RunDurableJobMessageResult['status'], permanent: boolean, error?: unknown): Promise<void> => {
    await scope?.onSettled?.({ storedJob, status, durationMs: Date.now() - startedMs, permanent, error })
  }
  const continuations = async (...stages: DurableJobContinuationStage[]): Promise<void> => {
    for (const stage of stages)
      await opts.dispatchContinuations?.({ storedJob, stage })
  }

  try {
    const runOnce = (): Promise<DispatchResult> => dispatchRegisteredJob({
      registry: opts.registry,
      job,
      createContext: async input => ({ ...(await opts.createJobContext({ ...input, storedJob })), reportStats }),
    })
    const dispatch = await (scope?.wrapDispatch ? scope.wrapDispatch(runOnce) : runOnce())

    if (!dispatch.success) {
      if (opts.failDispatchFailure !== false)
        await failDurableJob(opts.lifecycle, storedJob, dispatch.error ? formatJobError(dispatch.error) : 'Job dispatch failed')
      await settle('dispatch-failed', true, dispatch.error)
      await continuations('catch', 'finally')
      opts.message.ack()
      return { status: 'dispatch-failed', dispatch, error: dispatch.error }
    }

    if (dispatch.control?.handled) {
      // Persist the control outcome — an ack alone would leave the row reserved
      // (and, for `release`, silently drop the job instead of redelivering it).
      if (dispatch.control.action === 'failed') {
        await failDurableJob(opts.lifecycle, storedJob, dispatch.control.error ?? 'Job failed via ctx.fail()')
        await settle('failed', true, dispatch.control.error)
        await continuations('catch', 'finally')
        opts.message.ack()
        return { status: 'failed', dispatch }
      }
      const delaySeconds = dispatch.control.delaySeconds ?? 0
      await releaseDurableJob(opts.lifecycle, storedJob, { delaySeconds, error: dispatch.control.error })
      await settle('released', false, dispatch.control.error)
      opts.message.retry({ delaySeconds })
      return { status: 'released', dispatch }
    }

    const result = await opts.completeResult?.({ job: storedJob, dispatch })
    const hasStats = Object.keys(reportedStats).length > 0
    // Back-compat: with no reported stats, pass the result through untouched.
    const completeWith = hasStats
      ? { ...(result && typeof result === 'object' ? result : {}), ...reportedStats }
      : result
    await completeDurableJob(opts.lifecycle, storedJob, completeWith)
    await settle('completed', false)
    await continuations('then', 'finally')
    opts.message.ack()
    return { status: 'completed', dispatch }
  }
  catch (error) {
    // Terminal-failure decision: the caller's predicate (e.g. "never fail on
    // transient infra errors") wins; default is the Laravel cap attempts >= max.
    // `job.attempts` already counts this run (claim incremented it).
    const maxAttempts = opts.maxAttemptsOf?.(storedJob)
    const permanent = opts.isPermanentFailure
      ? opts.isPermanentFailure({ error, storedJob, attempts: job.attempts, maxAttempts })
      : (typeof maxAttempts === 'number' && job.attempts >= maxAttempts)
    if (permanent) {
      await failDurableJob(opts.lifecycle, storedJob, describeCause(error))
      await settle('exhausted', true, error)
      await continuations('catch', 'finally')
      opts.message.ack()
      return { status: 'exhausted', error: jobErrors.handlerThrew(error) }
    }
    const delaySeconds = typeof opts.retryDelaySeconds === 'function'
      ? opts.retryDelaySeconds({ error, job: storedJob })
      : opts.retryDelaySeconds ?? 0
    await releaseDurableJob(opts.lifecycle, storedJob, {
      delaySeconds,
      error: describeCause(error),
    })
    await settle('errored', false, error)
    opts.message.retry({ delaySeconds })
    return { status: 'errored', error: jobErrors.handlerThrew(error) }
  }
}
