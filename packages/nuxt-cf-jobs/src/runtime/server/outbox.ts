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
import { describeCause, describeCauseWithStack, formatJobError, isDurableJobOwnershipError, jobErrors, jobErrorToException } from './errors'
import { buildJobPayload } from './payload'
import { createJobTraceId, createJobUniqueKey, resolveJobBackoff, resolveJobMaxAttempts } from './policy'
import { sendBatchChunked, withSendBackpressure } from './queue'
import { parseJobInput } from './registry'
import { err, ok, unwrapResult } from './result'

function byteLength(value: string): number {
  return typeof Buffer !== 'undefined' ? Buffer.byteLength(value, 'utf8') : new TextEncoder().encode(value).byteLength
}

/**
 * Maximum serialized durable payload size.
 *
 * Durable payloads live in D1. Queue messages only carry `{ jobId, queue }`, so
 * the Cloudflare Queue message limit does not apply here. This leaves 100,000
 * bytes below D1's 2,000,000-byte row limit for storage overhead.
 */
export const DURABLE_JOB_MAX_PAYLOAD_BYTES = 1_900_000

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
  backoff?: number[]
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
   * Optional explicit unpublished insert used by the outbox publisher. Legacy
   * `insertJob` remains immediately claimable and must not be used when recovery
   * of a failed queue send is required.
   */
  stageJob?: (record: Record) => Promise<boolean>
  /**
   * Optional batched insert. When implemented, callers can persist many records in chunks
   * (chunked at the D1 100-statement limit by D1-backed implementations).
   */
  insertJobs?: (records: readonly Record[], opts?: { batchSize?: number }) => Promise<{ inserted: Record[], chunks: Array<{ ok: boolean, ids: string[], changes: number, error?: unknown }> }>
}

/** Publication evidence for a durable insert-then-send outbox protocol. */
export interface DurableJobPublicationRepository {
  markJobsPublished: (ids: readonly string[], opts?: { at?: number }) => Promise<number>
  noteJobsDispatchFailure: (ids: readonly string[], cause: unknown, opts?: { at?: number }) => Promise<number>
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
  /** May resolve asynchronously for lazily-loaded jobs. */
  getHandler?: (name: string) => JobHandler<unknown, Env, Db, Logger> | undefined | Promise<JobHandler<unknown, Env, Db, Logger> | undefined>
  /**
   * Loads the full definition when producer policy depends on executable fields
   * such as `input` or `uniqueId`.
   */
  loadJobDefinition?: (name: string) => Promise<JobDefinition<string, unknown, string, Env, Db, Logger> | undefined>
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

export interface NoteDurableJobDlqArrivalInput {
  messageAttempts: number
  at?: number
}

export type NoteDurableJobDlqArrivalResult
  = | { _tag: 'recorded' }
    | { _tag: 'obsolete' }

export interface DurableJobFailureEvidenceRepository {
  /**
   * Record that Cloudflare exhausted a durable message while its row could not
   * be claimed. This must not take ownership of the row.
   */
  noteDlqArrival: (id: string, input: NoteDurableJobDlqArrivalInput) => Promise<NoteDurableJobDlqArrivalResult>
}

/**
 * Well-known `failJob` options, always passable regardless of a repository's own
 * `FailOptions` — hence `Partial<FailOptions> & FailDurableJobOptions` on `failJob`
 * (`Partial<unknown>` collapses to `{}`), so the runtime can supply just a `cause`
 * without knowing a repository's bespoke options. `cause` is the ORIGINAL thrown
 * value: the `error` string is a rendering for the `failed_jobs` row, but a telemetry
 * hook wants the instance so it can report the real stack instead of rebuilding one.
 */
export interface FailDurableJobOptions {
  cause?: unknown
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
  failJob: (job: Job, error: string, opts?: Partial<FailOptions> & FailDurableJobOptions) => Promise<void>
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
  /** Suppress rows reaped more recently than this timestamp so CF redelivery wins first. */
  staleReleasedBefore?: number
  /**
   * Suppress rows whose last SUCCESSFUL dispatch is more recent than this
   * timestamp. A row that has never been dispatched, or whose last dispatch
   * failed, always stays eligible.
   *
   * Without it the sweep has no memory: `findDispatchableJobs` orders oldest
   * candidates first, so on a queue whose consumer is slower than its producer
   * it re-selects the same `limit` rows every tick and re-sends them
   * forever. That turns the recovery backstop into the system's largest producer
   * and deepens the very backlog it exists to clear (nuxtseo.com, 2026-07-28:
   * 300 x 30 ticks/hr = 9,000 writes/hr against a 100/hr consumer).
   *
   * Age alone cannot express this: `createdBefore` asks "is this row old?", which
   * is true of every row queued behind a backlog, whereas the question that
   * matters is "when was this one last sent?".
   */
  redispatchedBefore?: number
  limit?: number
  /** Defaults to unpublished outbox rows. Dev drainers may explicitly read all live rows. */
  publication?: 'unpublished' | 'published' | 'all'
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
  /**
   * Record that the orphan sweep re-dispatched these rows, so a later sweep can
   * exclude them via {@link DurableJobRecoveryQuery.redispatchedBefore}. Optional:
   * a repository without it degrades to the previous (memoryless) behaviour.
   *
   * Store this where it cannot be evicted. The D1 repository writes the
   * `last_dispatched_at` and `dispatch_attempts` columns.
   */
  noteOrphanRedispatch?: (ids: readonly string[], opts?: { at?: number }) => Promise<number>
  findStaleReservedJobs?: (query: DurableJobStaleRecoveryQuery) => Promise<Record[]>
  releaseStaleReservedJobs?: (query: DurableJobStaleRecoveryQuery) => Promise<number>
  /**
   * Terminally fail stale-reserved jobs that have already exhausted their
   * attempts (`attempts >= max_attempts`), moving them to `failed_jobs` instead
   * of leaving them to be re-released forever. Returns exact terminalized jobs
   * so callers can settle batches and publish telemetry.
   * Optional so older repositories degrade to the prior (revive-only) behaviour.
   */
  failStaleReservedJobs?: (query: DurableJobStaleRecoveryQuery) => Promise<DurableJobTerminalized<Queue>[]>
}

/** Durable evidence returned when the reaper terminalizes an abandoned claim. */
export interface DurableJobTerminalized<Queue extends string = string> {
  id: string
  queue: Queue
  batchId: string | null
  jobType: string
  payload: string
  attempts: number
  exception: string
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
  definition?: Pick<JobDefinition<Name, Payload, Queue, unknown, unknown, unknown>, 'name' | 'queue' | 'jobType' | 'input' | 'tries' | 'backoff' | 'unique' | 'uniqueId'>
  id?: string
  batchId?: string
  userId?: number
  siteId?: string
  partnerId?: string
  delaySeconds?: number
  now?: number
  traceId?: string
  defaultMaxAttempts?: number
  backoff?: number[]
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
  const definition = opts.definition ?? opts.registry?.getJobDefinition?.(opts.name) as Pick<JobDefinition<Name, Payload, Queue, unknown, unknown, unknown>, 'name' | 'queue' | 'jobType' | 'input' | 'tries' | 'backoff' | 'unique' | 'uniqueId'> | undefined

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
  if (bytes > DURABLE_JOB_MAX_PAYLOAD_BYTES)
    return err(jobErrors.payloadTooLarge(opts.name, bytes, DURABLE_JOB_MAX_PAYLOAD_BYTES))

  const maxAttempts = resolveJobMaxAttempts(definition) ?? opts.defaultMaxAttempts ?? 3
  const backoff = opts.backoff ?? (definition?.backoff === undefined
    ? undefined
    : Array.from({ length: maxAttempts }, (_, index) => resolveJobBackoff(definition.backoff, index + 1) ?? 0))

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
    maxAttempts,
    backoff,
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
  const definition = registry.loadJobDefinition
    ? await registry.loadJobDefinition(opts.name)
    : registry.getJobDefinition?.(opts.name)

  return prepareDurableJob({
    ...opts,
    registry,
    definition: definition as PrepareDurableJobOptions<
      Name,
      JobPayloadByName<Jobs, Name> & object,
      JobQueueByName<Jobs, Name>
    >['definition'],
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
  records: readonly Pick<DurableJobRecord<Queue>, 'id' | 'queue'>[],
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
  opts?: Partial<FailOptions> & FailDurableJobOptions,
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
): Promise<DurableJobTerminalized<Queue>[]> {
  return await repository.failStaleReservedJobs?.(query) ?? []
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
  repository: Pick<DurableJobRepository<Queue, Record>, 'insertJob'>
    & Partial<Pick<DurableJobRepository<Queue, Record>, 'stageJob'>>
    & Partial<DurableJobPublicationRepository>,
  publisher: Pick<QueuePublisher<Queue>, 'send'>,
  record: Record,
  opts?: { delaySeconds?: number },
): Promise<EnqueueDurableJobResult> {
  const publicationRepository = typeof repository.stageJob === 'function' && hasPublicationRepository(repository)
    ? repository as typeof repository & DurableJobPublicationRepository & { stageJob: NonNullable<typeof repository.stageJob> }
    : undefined
  const inserted = publicationRepository
    ? await publicationRepository.stageJob(record)
    : await repository.insertJob(record)
  if (!inserted)
    return { status: 'duplicate' }

  return await publisher.send(record.queue, toQueueJobMessage(record), opts)
    .then(async (sent): Promise<EnqueueDurableJobResult> => {
      if (!sent) {
        await publicationRepository?.noteJobsDispatchFailure([record.id], new Error(`Queue binding unavailable for ${record.queue}`))
        return { status: 'not-dispatched' }
      }
      if (publicationRepository) {
        const updated = await publicationRepository.markJobsPublished([record.id])
        if (updated !== 1)
          return { status: 'dispatch-failed', cause: new Error(`Published ${updated} of 1 durable rows`) }
      }
      return { status: 'enqueued' }
    })
    .catch(async (cause: unknown): Promise<EnqueueDurableJobResult> => {
      await publicationRepository?.noteJobsDispatchFailure([record.id], cause)
      return { status: 'dispatch-failed', cause }
    })
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

export type PublishDurableJobBatchResult<Queue extends string = string>
  = | { queue: Queue, status: 'published', jobIds: string[] }
    | { queue: Queue, status: 'not-dispatched', jobIds: string[] }
    | { queue: Queue, status: 'failed', jobIds: string[], cause: unknown }
    | { queue: Queue, status: 'state-failed', jobIds: string[], cause: unknown }

export interface SweepDurableJobsResult<Queue extends string> {
  swept: number
  dispatched: Array<DispatchDurableJobBatchResult<Queue>>
}

export async function sweepDispatchableDurableJobs<Queue extends string>(
  repository: Pick<DurableJobRecoveryRepository<Queue, Pick<DurableJobRecord<Queue>, 'id' | 'queue'>>, 'findDispatchableJobs'>
    & Partial<DurableJobPublicationRepository>,
  publisher: Pick<QueuePublisher<Queue>, 'sendBatch'>,
  query?: DurableJobRecoveryQuery,
): Promise<SweepDurableJobsResult<Queue>> {
  const records = await findDispatchableDurableJobs(repository, query)
  if (records.length === 0)
    return { swept: 0, dispatched: [] }
  const dispatched: Array<DispatchDurableJobBatchResult<Queue>> = hasPublicationRepository(repository)
    ? (await publishDurableJobBatch(repository, publisher, records, { now: query?.now })).map((result) => {
        if (result.status === 'published')
          return { queue: result.queue, status: 'sent' }
        if (result.status === 'not-dispatched')
          return { queue: result.queue, status: 'not-dispatched' }
        return { queue: result.queue, status: 'failed', cause: result.cause }
      })
    : await dispatchDurableJobBatch(publisher, records)
  return { swept: records.length, dispatched }
}

function hasPublicationRepository(
  repository: Partial<DurableJobPublicationRepository>,
): repository is DurableJobPublicationRepository {
  return typeof repository.markJobsPublished === 'function'
    && typeof repository.noteJobsDispatchFailure === 'function'
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

/**
 * Publish already-staged rows and durably record the outcome. A successful send
 * is acknowledged only after every row is marked published. If that state write
 * fails, rows remain recoverable and a duplicate delivery is possible by design.
 */
export async function publishDurableJobBatch<Queue extends string>(
  repository: DurableJobPublicationRepository,
  publisher: Pick<QueuePublisher<Queue>, 'sendBatch'>,
  records: readonly Pick<DurableJobRecord<Queue>, 'id' | 'queue'>[],
  opts?: { delaySeconds?: number, now?: number },
): Promise<Array<PublishDurableJobBatchResult<Queue>>> {
  const groups = groupQueueJobMessagesByQueue(records)
  return await Promise.all([...groups].map(async ([queue, messages]): Promise<PublishDurableJobBatchResult<Queue>> => {
    const jobIds = messages.map(message => message.jobId)
    const sent = await publisher.sendBatch(queue, messages, { delaySeconds: opts?.delaySeconds })
      .then(value => ({ _tag: 'sent' as const, value }))
      .catch((cause: unknown) => ({ _tag: 'failed' as const, cause }))

    if (sent._tag === 'failed') {
      return await repository.noteJobsDispatchFailure(jobIds, sent.cause, { at: opts?.now })
        .then((updated): PublishDurableJobBatchResult<Queue> => updated === jobIds.length
          ? { queue, status: 'failed', jobIds, cause: sent.cause }
          : { queue, status: 'state-failed', jobIds, cause: new AggregateError([sent.cause], `Recorded dispatch failure for ${updated} of ${jobIds.length} durable rows`) })
        .catch((evidenceCause: unknown): PublishDurableJobBatchResult<Queue> => ({
          queue,
          status: 'state-failed',
          jobIds,
          cause: new AggregateError([sent.cause, evidenceCause], 'Queue send and dispatch evidence writes failed'),
        }))
    }

    if (!sent.value) {
      const cause = new Error(`Queue binding unavailable for ${queue}`)
      return await repository.noteJobsDispatchFailure(jobIds, cause, { at: opts?.now })
        .then((updated): PublishDurableJobBatchResult<Queue> => updated === jobIds.length
          ? { queue, status: 'not-dispatched', jobIds }
          : { queue, status: 'state-failed', jobIds, cause: new AggregateError([cause], `Recorded dispatch failure for ${updated} of ${jobIds.length} durable rows`) })
        .catch((evidenceCause: unknown): PublishDurableJobBatchResult<Queue> => ({ queue, status: 'state-failed', jobIds, cause: evidenceCause }))
    }

    return await repository.markJobsPublished(jobIds, { at: opts?.now })
      .then((updated): PublishDurableJobBatchResult<Queue> => updated === jobIds.length
        ? { queue, status: 'published', jobIds }
        : { queue, status: 'state-failed', jobIds, cause: new Error(`Published ${updated} of ${jobIds.length} durable rows`) })
      .catch((cause: unknown): PublishDurableJobBatchResult<Queue> => ({ queue, status: 'state-failed', jobIds, cause }))
  }))
}

export type DurableJobMessageStatus
  = | 'invalid-message'
    | DurableJobClaimMiss
    | 'dispatch-failed'
    | 'released'
    | 'failed'
    | 'completed'
    | 'errored'
    | 'exhausted'
    | 'claim-error'

export interface RunDurableJobMessageOptions<
  StoredJob,
  Job extends DispatchableJob,
  Message extends QueueJobMessage = QueueJobMessage,
  Env = unknown,
  Db = unknown,
  Logger = unknown,
  CompleteResult = unknown,
> {
  /** Write a `cfjob:<name>` trace marker before the handler runs. See `trace-marker.ts`. */
  traceMarker?: boolean
  message: Pick<QueueMessage<Message>, 'body' | 'ack' | 'retry'>
  // The runtime never has bespoke fail options — it settles a terminal failure with a
  // `cause` and nothing else. A repository's own `FailOptions` stays on
  // `DurableJobLifecycle` / `failDurableJob` for callers that drive `failJob` directly.
  lifecycle: Pick<DurableJobLifecycle<StoredJob, CompleteResult, FailDurableJobOptions>, 'claimJob' | 'resolveClaimMiss' | 'completeJob' | 'failJob' | 'releaseJob'>
  registry: {
    getHandler: (name: string) => JobHandler<unknown, Env, Db, Logger> | undefined | Promise<JobHandler<unknown, Env, Db, Logger> | undefined>
    getJobDefinition?: (name: string) => JobDefinition<string, unknown, string, Env, Db, Logger> | undefined
    loadJobDefinition?: (name: string) => Promise<JobDefinition<string, unknown, string, Env, Db, Logger> | undefined>
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
  /**
   * Backoff (s) when the claim step THROWS (vs a clean miss) — the backing store
   * was unreachable/overloaded before any handler ran. The message is retried,
   * not failed, so the load is shed rather than the whole batch failing and CF
   * redelivering it (which re-claims and amplifies the overload). Default 10.
   */
  claimRetryDelaySeconds?: number | ((input: { error: unknown }) => number)
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
  /** Runs once, after terminal failure persistence and only when retries are exhausted. */
  onTerminalFailure?: (input: { error: unknown, storedJob: StoredJob }) => void | Promise<void>
  /** Required visibility fallback for settlement observer defects. Defaults to console.error. */
  onObserverError?: (input: { stage: 'settlement' | 'terminal-failure', cause: unknown, storedJob: StoredJob }) => void | Promise<void>
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

/** A terminal continuation that could not be dispatched after the job settled. */
export interface DurableJobContinuationFailure {
  stage: DurableJobContinuationStage
  cause: unknown
}

/**
 * Outcome of {@link runDurableJobMessage}, discriminated on `status` so each
 * variant carries exactly the data it can produce:
 * - claim phase: `invalid-message` (no job id) or a `DurableJobClaimMiss`
 *   (`already-resolved` / `in-flight` / `not-found`) — no dispatch happened.
 * - `dispatch-failed`: the handler could not run; `error` is the typed `JobError`.
 * - `failed` / `released`: the handler ran and called `ctx.fail()` / `ctx.release()`.
 * - `completed`: the handler ran to completion.
 * - terminal results expose `continuationFailures` when a `then`/`catch`/`finally`
 *   continuation could not be dispatched; later stages are still attempted.
 * - `errored`: the handler threw an unexpected defect; the message is retried and
 *   `error` carries the defect as a `handler-threw` `JobError` (`error.cause` is the
 *   original throw). Distinct from `released` (a deliberate `ctx.release()`).
 * - `exhausted`: the handler threw AND `attempts` reached `maxAttemptsOf` — the job
 *   was failed (→ `failed_jobs`) rather than retried. Terminal.
 * - `claim-error`: the claim step itself threw (e.g. an overloaded backing store)
 *   before any handler ran; the message is retried with backoff. Non-terminal, so
 *   the row is left untouched for the redelivery to re-claim. Distinct from a
 *   `DurableJobClaimMiss` (a clean miss where the row was already terminal).
 */
export type RunDurableJobMessageResult
  = | { status: 'invalid-message' }
    | { status: DurableJobClaimMiss }
    | { status: 'dispatch-failed', dispatch: DispatchResult, error?: JobError, continuationFailures?: DurableJobContinuationFailure[] }
    | { status: 'failed', dispatch: DispatchResult, terminalFailureCause?: unknown, continuationFailures?: DurableJobContinuationFailure[] }
    | { status: 'released', dispatch: DispatchResult }
    | { status: 'completed', dispatch: DispatchResult, continuationFailures?: DurableJobContinuationFailure[] }
    | { status: 'errored', error: JobError }
    | { status: 'exhausted', error: JobError, terminalFailureCause?: unknown, continuationFailures?: DurableJobContinuationFailure[] }
    | { status: 'claim-error', error: JobError }

export async function runDurableJobMessage<
  StoredJob,
  Job extends DispatchableJob,
  Message extends QueueJobMessage = QueueJobMessage,
  Env = unknown,
  Db = unknown,
  Logger = unknown,
  CompleteResult = unknown,
>(
  opts: RunDurableJobMessageOptions<StoredJob, Job, Message, Env, Db, Logger, CompleteResult>,
): Promise<RunDurableJobMessageResult> {
  const jobId = opts.getJobId?.(opts.message.body) ?? opts.message.body.jobId
  if (!jobId) {
    opts.message.ack()
    return { status: 'invalid-message' }
  }

  // The claim runs before the dispatch try/catch below, so a throw here (e.g. the
  // backing store is overloaded / "queued for too long") would otherwise escape
  // and fail EVERY sibling message in the batch — CF then redelivers the whole
  // batch, which re-claims and piles more load onto the already-overloaded store
  // (a self-amplifying loop). Catch it, retry just this message with backoff, and
  // leave the row untouched (the claim UPDATE is atomic: it either committed or
  // threw before commit, so the redelivery can re-claim cleanly).
  let claimed: DurableJobClaimResult<StoredJob>
  try {
    claimed = await claimDurableJob(opts.lifecycle, jobId)
  }
  catch (error) {
    const delaySeconds = typeof opts.claimRetryDelaySeconds === 'function'
      ? opts.claimRetryDelaySeconds({ error })
      : opts.claimRetryDelaySeconds ?? 10
    opts.message.retry({ delaySeconds })
    return { status: 'claim-error', error: jobErrors.claimThrew(error) }
  }
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
  const observeSettlement = async (status: RunDurableJobMessageResult['status'], permanent: boolean, error?: unknown): Promise<void> => {
    await settle(status, permanent, error).catch(async (cause: unknown) => {
      await reportObserverError(opts.onObserverError, { stage: 'settlement', cause, storedJob })
    })
  }
  const runTerminalFailure = async (error: unknown): Promise<unknown | undefined> => {
    return await Promise.resolve(opts.onTerminalFailure?.({ error, storedJob }))
      .then(() => undefined)
      .catch(async (cause: unknown) => {
        await reportObserverError(opts.onObserverError, { stage: 'terminal-failure', cause, storedJob })
        return cause
      })
  }
  const dispatchTerminalContinuations = async (...stages: DurableJobContinuationStage[]): Promise<DurableJobContinuationFailure[]> => {
    const failures: DurableJobContinuationFailure[] = []
    for (const stage of stages) {
      try {
        await opts.dispatchContinuations?.({ storedJob, stage })
      }
      catch (cause) {
        failures.push({ stage, cause })
      }
    }
    return failures
  }
  const obsoleteDelivery = (error: unknown): RunDurableJobMessageResult | null => {
    if (!isDurableJobOwnershipError(error))
      return null
    opts.message.ack()
    return { status: 'in-flight' }
  }

  try {
    const runOnce = (): Promise<DispatchResult> => dispatchRegisteredJob({
      registry: opts.registry,
      job,
      traceMarker: opts.traceMarker,
      createContext: async input => ({ ...(await opts.createJobContext({ ...input, storedJob })), reportStats }),
    })
    const dispatch = await (scope?.wrapDispatch ? scope.wrapDispatch(runOnce) : runOnce())

    if (!dispatch.success) {
      if (opts.failDispatchFailure !== false) {
        try {
          await failDurableJob(opts.lifecycle, storedJob, dispatch.error ? formatJobError(dispatch.error) : 'Job dispatch failed')
        }
        catch (error) {
          const obsolete = obsoleteDelivery(error)
          if (obsolete)
            return obsolete
          throw error
        }
      }
      await observeSettlement('dispatch-failed', true, dispatch.error)
      const continuationFailures = await dispatchTerminalContinuations('catch', 'finally')
      opts.message.ack()
      return { status: 'dispatch-failed', dispatch, error: dispatch.error, ...(continuationFailures.length > 0 ? { continuationFailures } : {}) }
    }

    if (dispatch.control?.handled) {
      // Persist the control outcome — an ack alone would leave the row reserved
      // (and, for `release`, silently drop the job instead of redelivering it).
      if (dispatch.control.action === 'failed') {
        try {
          await failDurableJob(opts.lifecycle, storedJob, dispatch.control.error ?? 'Job failed via ctx.fail()')
        }
        catch (error) {
          const obsolete = obsoleteDelivery(error)
          if (obsolete)
            return obsolete
          throw error
        }
        await observeSettlement('failed', true, dispatch.control.error)
        const terminalFailureCause = await runTerminalFailure(new Error(dispatch.control.error ?? 'Job failed via ctx.fail()'))
        const continuationFailures = await dispatchTerminalContinuations('catch', 'finally')
        opts.message.ack()
        return {
          status: 'failed',
          dispatch,
          ...(terminalFailureCause === undefined ? {} : { terminalFailureCause }),
          ...(continuationFailures.length > 0 ? { continuationFailures } : {}),
        }
      }
      const delaySeconds = dispatch.control.delaySeconds ?? 0
      try {
        await releaseDurableJob(opts.lifecycle, storedJob, { delaySeconds, error: dispatch.control.error })
      }
      catch (error) {
        const obsolete = obsoleteDelivery(error)
        if (obsolete)
          return obsolete
        throw error
      }
      await observeSettlement('released', false, dispatch.control.error)
      opts.message.retry({ delaySeconds })
      return { status: 'released', dispatch }
    }

    const result = await opts.completeResult?.({ job: storedJob, dispatch })
    const hasStats = Object.keys(reportedStats).length > 0
    // Back-compat: with no reported stats, pass the result through untouched.
    const completeWith = hasStats
      ? { ...(result && typeof result === 'object' ? result : {}), ...reportedStats }
      : result
    try {
      await completeDurableJob(opts.lifecycle, storedJob, completeWith)
    }
    catch (error) {
      const obsolete = obsoleteDelivery(error)
      if (obsolete)
        return obsolete
      throw error
    }
    await observeSettlement('completed', false)
    const continuationFailures = await dispatchTerminalContinuations('then', 'finally')
    opts.message.ack()
    return { status: 'completed', dispatch, ...(continuationFailures.length > 0 ? { continuationFailures } : {}) }
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
      try {
        // Terminal: this row is the ONLY record of the defect once the message is
        // acked, so persist the stack + cause chain, not just `.message`. The
        // release path below stays on `describeCause` — it fires on every retry
        // and a stack there would be noise. `cause` hands the original throw to the
        // lifecycle hooks so telemetry reports it directly (D1 can only hold text).
        await failDurableJob(opts.lifecycle, storedJob, describeCauseWithStack(error), { cause: error })
      }
      catch (failError) {
        const obsolete = obsoleteDelivery(failError)
        if (obsolete)
          return obsolete
        throw failError
      }
      await observeSettlement('exhausted', true, error)
      const terminalFailureCause = await runTerminalFailure(error)
      const continuationFailures = await dispatchTerminalContinuations('catch', 'finally')
      opts.message.ack()
      return {
        status: 'exhausted',
        error: jobErrors.handlerThrew(error),
        ...(terminalFailureCause === undefined ? {} : { terminalFailureCause }),
        ...(continuationFailures.length > 0 ? { continuationFailures } : {}),
      }
    }
    const delaySeconds = typeof opts.retryDelaySeconds === 'function'
      ? opts.retryDelaySeconds({ error, job: storedJob })
      : opts.retryDelaySeconds ?? 0
    try {
      await releaseDurableJob(opts.lifecycle, storedJob, {
        delaySeconds,
        error: describeCause(error),
      })
    }
    catch (releaseError) {
      const obsolete = obsoleteDelivery(releaseError)
      if (obsolete)
        return obsolete
      throw releaseError
    }
    await observeSettlement('errored', false, error)
    opts.message.retry({ delaySeconds })
    return { status: 'errored', error: jobErrors.handlerThrew(error) }
  }
}

async function reportObserverError<StoredJob>(
  observer: RunDurableJobMessageOptions<StoredJob, DispatchableJob>['onObserverError'],
  input: { stage: 'settlement' | 'terminal-failure', cause: unknown, storedJob: StoredJob },
): Promise<void> {
  if (observer) {
    await Promise.resolve().then(() => observer(input)).catch((fallbackCause: unknown) => {
      console.error('[nuxt-cf-jobs] observer error fallback failed', { input, fallbackCause })
    })
    return
  }
  console.error('[nuxt-cf-jobs] observer error', input)
}
