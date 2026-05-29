import type { SendBackpressureOptions } from './queue'
import type { AnyJobDefinition, JobNameOf, JobPayloadByName, JobQueueByName } from './registry'
import type {
  CloudflareQueue,
  DispatchableJob,
  DispatchResult,
  JobContext,
  JobControlResult,
  JobDefinition,
  JobHandler,
  QueueMessage,
  QueueSendOptions,
} from './types'
import { dispatchRegisteredJob } from './dispatch'
import { buildJobPayload } from './payload'
import { createJobTraceId, createJobUniqueKey, resolveJobMaxAttempts } from './policy'
import { CF_QUEUE_MAX_MESSAGE_BYTES, sendBatchChunked, withSendBackpressure } from './queue'
import { parseJobInput } from './registry'

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
  getHandler?: (name: string) => JobHandler<unknown, Env, Db, Logger> | undefined
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

export async function prepareDurableJob<
  const Name extends string,
  Payload extends object,
  Queue extends string,
>(opts: PrepareDurableJobOptions<Name, Payload, Queue>): Promise<DurableJobRecord<Queue>> {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const definition = opts.definition ?? opts.registry?.getJobDefinition?.(opts.name) as Pick<JobDefinition<Name, Payload, Queue, unknown, unknown, unknown>, 'name' | 'queue' | 'jobType' | 'input' | 'tries' | 'maxAttempts' | 'unique' | 'uniqueId'> | undefined
  const route = resolveDurableJobRoute(opts.name, opts.route, definition, opts.registry)
  const parsedPayload = parseJobInput(definition as never, opts.payload)
  if (!parsedPayload.success)
    throw new Error(`Invalid payload for task: ${opts.name}`)

  const continuations = normalizeDurableJobContinuations(opts.continuations)
  validateDurableJobContinuations(opts.registry, continuations)

  const uniqueKey = definition?.unique
    ? await createJobUniqueKey(opts.name, parsedPayload.data, definition.uniqueId as never)
    : undefined
  const payload = buildJobPayload(opts.name, parsedPayload.data as Payload)
  const serialized = JSON.stringify(continuations ? { ...payload, _continuations: continuations } : payload)
  if (byteLength(serialized) > CF_QUEUE_MAX_MESSAGE_BYTES)
    throw new Error(`Job payload exceeds Cloudflare Queue limit of ${CF_QUEUE_MAX_MESSAGE_BYTES} bytes for task: ${opts.name}`)

  return {
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
  }
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
): DurableJobRoute<Queue | string> {
  if (route)
    return route

  const registeredRoute = registry?.getJobRoute?.(name)
  if (registeredRoute)
    return registeredRoute

  if (definition)
    return { queue: definition.queue, jobType: definition.jobType ?? definition.name }

  throw new Error(`No route for task: ${name}`)
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

export function validateDurableJobContinuations(
  registry: DurableJobRegistryLike | undefined,
  continuations: DurableJobContinuations<string, Record<string, unknown>, string> | undefined,
): void {
  if (!registry || !continuations)
    return

  for (const stage of ['then', 'catch', 'finally'] as const) {
    for (const continuation of continuations[stage] ?? []) {
      const definition = registry.getJobDefinition?.(continuation.name)
      if (!definition)
        throw new Error(`No handler for continuation task: ${continuation.name}`)

      const parsed = parseJobInput(definition, continuation.payload)
      if (!parsed.success)
        throw new Error(`Invalid payload for continuation task: ${continuation.name}`)

      if (continuation.queue && definition.queue !== continuation.queue)
        throw new Error(`Continuation task "${continuation.name}" is registered on queue "${definition.queue}", not "${continuation.queue}"`)
    }
  }
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

export async function enqueueDurableJob<
  Queue extends string,
  Record extends DurableJobRecord<Queue>,
>(
  repository: Pick<DurableJobRepository<Queue, Record>, 'insertJob'>,
  publisher: Pick<QueuePublisher<Queue>, 'send'>,
  record: Record,
  opts?: { delaySeconds?: number },
): Promise<{ inserted: boolean, dispatched: boolean, error?: unknown }> {
  const inserted = await repository.insertJob(record)
  if (!inserted)
    return { inserted: false, dispatched: false }

  const dispatched = await publisher
    .send(record.queue, toQueueJobMessage(record), opts)
    .catch(error => ({ error }))

  if (typeof dispatched === 'object' && dispatched && 'error' in dispatched)
    return { inserted: true, dispatched: false, error: dispatched.error }

  return { inserted: true, dispatched }
}

export interface SweepDurableJobsResult<Queue extends string> {
  swept: number
  dispatched: Array<{ queue: Queue, dispatched: boolean, error?: unknown }>
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
): Promise<Array<{ queue: Queue, dispatched: boolean, error?: unknown }>> {
  const groups = groupQueueJobMessagesByQueue(records)
  return await Promise.all(
    [...groups].map(async ([queue, messages]) => {
      try {
        return {
          queue,
          dispatched: await publisher.sendBatch(queue, messages, opts),
        }
      }
      catch (error) {
        return { queue, dispatched: false, error }
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
    getHandler: (name: string) => JobHandler<unknown, Env, Db, Logger> | undefined
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
  getJobId?: (message: Message) => string | undefined
  retryDelaySeconds?: number | ((input: { error: unknown, job: StoredJob }) => number)
  failDispatchFailure?: boolean
  completeResult?: (input: { job: StoredJob, dispatch: DispatchResult }) => unknown | Promise<unknown>
}

export interface RunDurableJobMessageResult {
  status: DurableJobMessageStatus
  dispatch?: DispatchResult
  error?: unknown
}

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

  try {
    const dispatch = await dispatchRegisteredJob({
      registry: opts.registry,
      job,
      createContext: input => opts.createJobContext({ ...input, storedJob }),
    })

    if (!dispatch.success) {
      if (opts.failDispatchFailure !== false)
        await failDurableJob(opts.lifecycle, storedJob, dispatch.error ?? 'Job dispatch failed')
      opts.message.ack()
      return { status: 'dispatch-failed', dispatch }
    }

    if (dispatch.control?.handled) {
      opts.message.ack()
      return { status: dispatch.control.action === 'failed' ? 'failed' : 'released', dispatch }
    }

    await completeDurableJob(opts.lifecycle, storedJob, await opts.completeResult?.({ job: storedJob, dispatch }))
    opts.message.ack()
    return { status: 'completed', dispatch }
  }
  catch (error) {
    const delaySeconds = typeof opts.retryDelaySeconds === 'function'
      ? opts.retryDelaySeconds({ error, job: storedJob })
      : opts.retryDelaySeconds ?? 0
    await releaseDurableJob(opts.lifecycle, storedJob, {
      delaySeconds,
      error: error instanceof Error ? error.message : String(error),
    })
    opts.message.retry({ delaySeconds })
    return { status: 'released', error }
  }
}
