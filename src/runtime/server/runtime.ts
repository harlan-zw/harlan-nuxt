import type { BatchProgress, DurableBatchStore, SettleBatchMemberOptions, SettleBatchMemberResult } from './batch'
import type { D1DatabaseLike, D1DurableJobRepository } from './d1'
import type { JobMetricsSink } from './metrics'
import type {
  CreateJobBatchOptions,
  CreateJobBatchResult,
  DurableJobContinuation,
  DurableJobRecord,
  EnqueueDurableJobResult,
  PruneDurableJobsOptions,
  PruneDurableJobsResult,
  QueuePublisher,
  RunDurableJobMessageOptions,
  RunDurableJobMessageResult,
} from './outbox'
import type { DispatchableJob, JobDefinition, JobHandler, QueueBatch, QueueMessage } from './types'
import { createD1DurableBatchStore, createJobBatch, settleBatchMember } from './batch'
import { createD1DurableJobRepository } from './d1'
import { dispatchRegisteredJob } from './dispatch'
import { formatJobError } from './errors'
import { metricsSinkToRepoHooks } from './metrics'
import { createQueuePublisher, enqueueDurableJob, prepareDurableJob, pruneDurableJobs, runDurableJobMessage } from './outbox'
import { resolveJobRetryDelay } from './policy'

// ============================================
// Consumer loop: claim → run → settle → progress
// ============================================
//
// `runDurableJobMessage` (outbox) owns the per-message lifecycle (claim →
// dispatch → complete/fail/release/ack-retry). What every batch-aware consumer
// then hand-rolls on top — settle the member, fire `onFinish` on the winning
// settle, emit progress — lives here so it is written and tested ONCE. The
// app-level "wrap settleBatchMember and emit progress" boilerplate (and the
// dropped-`await` bugs it invites) disappears.

export interface RunDurableJobBatchMessageOptions<
  StoredJob,
  Job extends DispatchableJob,
  Message extends { jobId: string, queue: string } = { jobId: string, queue: string },
  Env = unknown,
  Db = unknown,
  Logger = unknown,
> extends RunDurableJobMessageOptions<StoredJob, Job, Message, Env, Db, Logger> {
  store: DurableBatchStore
  /** Run the winning settle's `onFinish`. Defaults to nothing. */
  dispatchOnFinish?: SettleBatchMemberOptions['dispatchOnFinish']
  /** Notified after each settle with the batch's progress (live UI / telemetry). */
  onBatchProgress?: (progress: BatchProgress) => void | Promise<void>
}

export interface RunDurableJobBatchMessageResult {
  run: RunDurableJobMessageResult
  settled: SettleBatchMemberResult | null
}

/**
 * Run one queue message through the full durable lifecycle, then settle its
 * batch. Only terminal outcomes (`completed` / `failed` / `dispatch-failed`)
 * settle — a `released`/`errored` message will re-run, so settling it would
 * double-count. The settle's progress is forwarded to `onBatchProgress`, always
 * awaited so `onFinish` has fired before this resolves.
 */
export async function runDurableJobBatchMessage<
  StoredJob,
  Job extends DispatchableJob,
  Message extends { jobId: string, queue: string } = { jobId: string, queue: string },
  Env = unknown,
  Db = unknown,
  Logger = unknown,
>(
  opts: RunDurableJobBatchMessageOptions<StoredJob, Job, Message, Env, Db, Logger>,
): Promise<RunDurableJobBatchMessageResult> {
  const run = await runDurableJobMessage(opts)

  const terminal = run.status === 'completed' || run.status === 'failed' || run.status === 'dispatch-failed'
  if (!terminal)
    return { run, settled: null }

  const jobId = opts.getJobId?.(opts.message.body) ?? opts.message.body.jobId
  if (!jobId)
    return { run, settled: null }

  const settled = await settleBatchMember({
    store: opts.store,
    jobId,
    failed: run.status !== 'completed',
    dispatchOnFinish: opts.dispatchOnFinish,
  })
  if (settled.progress && opts.onBatchProgress)
    await opts.onBatchProgress(settled.progress)

  return { run, settled }
}

// ============================================
// Lightweight (non-durable `_task`) message
// ============================================
//
// A `{ _task }` payload has no `jobs` row — it dispatches directly, deduped per
// isolate (durable messages are deduped by `claimJob`). Mirrors the durable
// path's control handling minus the persistence.

export interface RunLightweightMessageOptions<Env = unknown, Db = unknown, Logger = unknown> {
  message: Pick<QueueMessage, 'id' | 'body' | 'attempts' | 'ack' | 'retry'>
  registry: DurableJobsRuntimeRegistry<Env, Db, Logger>
  createJobContext: ConsumerContextFactory<Env, Db, Logger>
  /** Per-isolate dedup of at-least-once redeliveries. Return true to drop. */
  isDuplicate?: (id: string | undefined) => boolean
  /** Diagnostic sink for dropped/invalid messages (no throw). */
  onLog?: (event: { stage: string, taskName?: string, error?: string }) => void
}

export type RunLightweightMessageResult
  = | { status: 'invalid' | 'duplicate' | 'dispatch-failed' | 'released' | 'completed' | 'errored' }

export async function runLightweightMessage<Env, Db, Logger>(
  opts: RunLightweightMessageOptions<Env, Db, Logger>,
): Promise<RunLightweightMessageResult> {
  const { message, registry, createJobContext } = opts
  const body = (message.body ?? {}) as Record<string, unknown>
  const taskName = typeof body._task === 'string' ? body._task : ''
  const definition = taskName ? registry.getJobDefinition?.(taskName) : undefined
  if (!definition) {
    opts.onLog?.({ stage: 'invalid_payload', taskName, error: taskName ? `No handler for task: ${taskName}` : 'No _task in payload' })
    message.ack()
    return { status: 'invalid' }
  }

  if (opts.isDuplicate?.(message.id)) {
    message.ack()
    return { status: 'duplicate' }
  }

  const job: DispatchableJob = {
    id: `${taskName}:${typeof body.jobId === 'string' ? body.jobId : crypto.randomUUID()}`,
    queue: definition.queue ?? '',
    payload: body,
    attempts: message.attempts,
    batchId: null,
    siteId: typeof body.siteId === 'string' ? body.siteId : null,
    userId: typeof body.userId === 'number' ? body.userId : null,
  }

  try {
    const dispatch = await dispatchRegisteredJob({
      registry,
      job,
      createContext: ({ control }) => createJobContext({ job, storedJob: job, taskName, payload: job.payload, control }),
    })
    if (!dispatch.success) {
      opts.onLog?.({ stage: 'invalid_payload', taskName, error: dispatch.error ? formatJobError(dispatch.error) : 'invalid payload' })
      message.ack()
      return { status: 'dispatch-failed' }
    }
    if (dispatch.control?.action === 'released') {
      message.retry({ delaySeconds: dispatch.control.delaySeconds ?? 0 })
      return { status: 'released' }
    }
    message.ack()
    return { status: 'completed' }
  }
  catch (error) {
    // Rely on CF max_retries → DLQ for terminal exhaustion.
    const delaySeconds = resolveJobRetryDelay(definition, message.attempts)
    opts.onLog?.({ stage: 'unexpected', taskName, error: error instanceof Error ? error.message : String(error) })
    message.retry({ delaySeconds })
    return { status: 'errored' }
  }
}

// ============================================
// Full queue-batch consumer (DLQ + durable + lightweight)
// ============================================

export interface ConsumeQueueBatchOptions<Queue extends string, Env, Db, Logger> {
  batch: QueueBatch
  repository: D1DurableJobRepository<Queue>
  store: DurableBatchStore
  registry: DurableJobsRuntimeRegistry<Env, Db, Logger>
  createJobContext: ConsumerContextFactory<Env, Db, Logger>
  dispatchOnFinish?: SettleBatchMemberOptions['dispatchOnFinish']
  onBatchProgress?: (progress: BatchProgress) => void | Promise<void>
  retryDelaySeconds?: RunDurableJobMessageOptions<unknown, DispatchableJob>['retryDelaySeconds']
  /** Defaults to a `-dlq` suffix check. */
  isDlqQueue?: (queue: string) => boolean
  isDuplicate?: (id: string | undefined) => boolean
  onLog?: (event: { stage: string, queue?: string, taskName?: string, jobId?: string, error?: string }) => void
}

function defaultIsDlqQueue(queue: string): boolean {
  return queue.includes('-dlq')
}

/**
 * Process one CF queue batch end-to-end — the loop both apps hand-roll:
 * - a DLQ-queue batch settles each durable member (failed) so a CF-exhausted
 *   message can't hang its batch;
 * - `{ jobId }` envelopes take the durable path (claim → run → settle + progress);
 * - `{ _task }` payloads take the lightweight path.
 */
export async function consumeQueueBatch<Queue extends string, Env, Db, Logger>(
  opts: ConsumeQueueBatchOptions<Queue, Env, Db, Logger>,
): Promise<void> {
  const isDlq = opts.isDlqQueue ?? defaultIsDlqQueue

  if (isDlq(opts.batch.queue)) {
    for (const message of opts.batch.messages) {
      const body = (message.body ?? {}) as Record<string, unknown>
      const jobId = typeof body.jobId === 'string' ? body.jobId : undefined
      opts.onLog?.({ stage: 'dlq', queue: opts.batch.queue, taskName: typeof body._task === 'string' ? body._task : undefined, jobId })
      if (jobId) {
        // Laravel's "exhausted → failed_jobs" transition. CF has given up on this
        // message, so move the row to failed_jobs (terminal): it leaves `jobs`
        // (no leak, an outbox sweep can't re-dispatch it) and becomes
        // retry/forget/prune-able. Then settle so the batch can't hang. All
        // best-effort — a raced claim/settle is recovered by reclaim/recovery.
        const claimed = await opts.repository.claimJob(jobId).catch(() => null)
        if (claimed)
          await opts.repository.failJob(claimed, 'Exhausted retries (dead-letter queue)').catch(() => {})
        await settleBatchMember({ store: opts.store, jobId, failed: true, dispatchOnFinish: opts.dispatchOnFinish })
          .then(r => r.progress && opts.onBatchProgress ? opts.onBatchProgress(r.progress) : undefined)
          .catch(() => {})
      }
      message.ack()
    }
    return
  }

  for (const message of opts.batch.messages) {
    const body = (message.body ?? {}) as Record<string, unknown>
    const jobId = typeof body.jobId === 'string' ? body.jobId : undefined
    if (jobId) {
      await runDurableJobBatchMessage({
        message,
        lifecycle: opts.repository,
        registry: opts.registry,
        store: opts.store,
        toDispatchableJob: opts.repository.toDispatchableJob,
        createJobContext: opts.createJobContext,
        retryDelaySeconds: opts.retryDelaySeconds,
        dispatchOnFinish: opts.dispatchOnFinish,
        onBatchProgress: opts.onBatchProgress,
      })
    }
    else {
      await runLightweightMessage({
        message,
        registry: opts.registry,
        createJobContext: opts.createJobContext,
        isDuplicate: opts.isDuplicate,
        onLog: opts.onLog,
      })
    }
  }
}

// ============================================
// Runtime factory: one call → enqueue / batch / consume / prune
// ============================================

export interface DurableJobsRuntimeRegistry<Env = unknown, Db = unknown, Logger = unknown> {
  getHandler: (name: string) => JobHandler<unknown, Env, Db, Logger> | undefined
  getJobDefinition?: (name: string) => JobDefinition<string, unknown, string, Env, Db, Logger> | undefined
  getJobRoute?: (name: string) => { queue: string, jobType: string } | undefined
}

type ConsumerMessage = RunDurableJobMessageOptions<unknown, DispatchableJob>['message']
type ConsumerContextFactory<Env, Db, Logger> = RunDurableJobMessageOptions<unknown, DispatchableJob, { jobId: string, queue: string }, Env, Db, Logger>['createJobContext']

export interface CreateDurableJobsRuntimeOptions<
  Queue extends string = string,
  Env = unknown,
  Db = unknown,
  Logger = unknown,
> {
  /** Raw D1 binding. The repo + batch store are built from it. */
  db: D1DatabaseLike
  /** Worker `env`, used to resolve queue bindings. */
  env: Record<string, unknown>
  registry: DurableJobsRuntimeRegistry<Env, Db, Logger>
  /** Map a logical queue to its `env` binding name. */
  resolveQueueBinding: (queue: Queue) => string | undefined
  /** Build the per-job context (db, log, control, …). */
  createJobContext: ConsumerContextFactory<Env, Db, Logger>
  /** Laravel `retry_after` — reclaim a reservation older than this on claim. */
  reclaimAfterSeconds?: number
  /** Telemetry sink; wired into the repo's lifecycle hooks automatically. */
  metricsSink?: JobMetricsSink
  /** Notified after each batch settle. */
  onBatchProgress?: (progress: BatchProgress) => void | Promise<void>
  /** Per-throw retry backoff for the consumer. */
  retryDelaySeconds?: RunDurableJobMessageOptions<unknown, DispatchableJob>['retryDelaySeconds']
  onMissingBinding?: (queue: Queue, count: number) => void | Promise<void>
  /** Classify a queue as a dead-letter queue (defaults to a `-dlq` suffix check). */
  isDlqQueue?: (queue: string) => boolean
  /**
   * Per-isolate dedup set for the lightweight `_task` path. Pass a module-level
   * Set so redeliveries dedup across invocations (durable jobs are claim-guarded,
   * so they don't need this).
   */
  dedup?: Set<string>
  /** Diagnostic log sink for DLQ / dropped lightweight messages. */
  onLog?: (event: { stage: string, queue?: string, taskName?: string, jobId?: string, error?: string }) => void
}

const DEFAULT_DEDUP_CAPACITY = 1024

function makeIsDuplicate(seen: Set<string> | undefined): ((id: string | undefined) => boolean) | undefined {
  if (!seen)
    return undefined
  return (id) => {
    if (!id)
      return false
    if (seen.has(id))
      return true
    seen.add(id)
    if (seen.size > DEFAULT_DEDUP_CAPACITY) {
      const first = seen.values().next().value
      if (first !== undefined)
        seen.delete(first)
    }
    return false
  }
}

export interface DurableJobsRuntime<Queue extends string = string> {
  repository: D1DurableJobRepository<Queue>
  store: DurableBatchStore
  publisher: QueuePublisher<Queue>
  /** Durably enqueue a prepared record (persist row + dispatch message). */
  enqueue: (record: DurableJobRecord<Queue>, opts?: { delaySeconds?: number }) => Promise<EnqueueDurableJobResult>
  /** Register + dispatch a batch; `onFinish` fires once every member settles. */
  createBatch: (opts: Omit<CreateJobBatchOptions<string, Record<string, unknown>, Queue>, 'store' | 'repository' | 'publisher'>) => Promise<CreateJobBatchResult>
  /** Run one durable queue message end-to-end (lifecycle + batch settle + progress). */
  consumeMessage: (message: ConsumerMessage) => Promise<RunDurableJobBatchMessageResult>
  /** Process a whole CF queue batch (DLQ + durable + lightweight) — the consumer entrypoint. */
  consumeBatch: (batch: QueueBatch) => Promise<void>
  /** Prune terminal rows (completed jobs / finished batches / failed jobs). */
  prune: (opts: PruneDurableJobsOptions) => Promise<PruneDurableJobsResult>
}

/**
 * Bundle the durable-jobs verbs behind one factory so consumers stop
 * hand-assembling repo + store + publisher + enqueue + batch + consumer loop.
 * The metrics sink is wired into the repo here (no `metricsSinkToRepoHooks` at
 * call sites), and `onFinish` continuations are enqueued durably by default.
 */
export function createDurableJobsRuntime<
  Queue extends string = string,
  Env = unknown,
  Db = unknown,
  Logger = unknown,
>(opts: CreateDurableJobsRuntimeOptions<Queue, Env, Db, Logger>): DurableJobsRuntime<Queue> {
  const repository = createD1DurableJobRepository<Queue>(opts.db, {
    reclaimAfterSeconds: opts.reclaimAfterSeconds,
    ...(opts.metricsSink ? metricsSinkToRepoHooks(opts.metricsSink) : {}),
  })
  const store = createD1DurableBatchStore(opts.db)
  const publisher = createQueuePublisher<Record<string, unknown>, Queue>(
    opts.env,
    opts.resolveQueueBinding,
    { onMissingBinding: opts.onMissingBinding },
  )

  // Default onFinish: enqueue the continuation durably (survives an isolate
  // recycle, same guarantee the batch members get).
  const dispatchOnFinish: SettleBatchMemberOptions['dispatchOnFinish'] = async ({ continuation }) => {
    const c = continuation as DurableJobContinuation
    const record = await prepareDurableJob({ name: c.name, payload: c.payload, registry: opts.registry })
    await enqueueDurableJob(repository, publisher, record as DurableJobRecord<Queue>)
  }

  const isDuplicate = makeIsDuplicate(opts.dedup)

  return {
    repository,
    store,
    publisher,
    enqueue: (record, enqueueOpts) => enqueueDurableJob(repository, publisher, record, enqueueOpts),
    createBatch: batchOpts => createJobBatch<string, Record<string, unknown>, Queue>({
      store,
      repository: repository as { insertJobs: NonNullable<D1DurableJobRepository<Queue>['insertJobs']> },
      publisher,
      ...batchOpts,
    }),
    consumeMessage: message => runDurableJobBatchMessage({
      message,
      lifecycle: repository,
      registry: opts.registry,
      store,
      toDispatchableJob: repository.toDispatchableJob,
      createJobContext: opts.createJobContext,
      retryDelaySeconds: opts.retryDelaySeconds,
      dispatchOnFinish,
      onBatchProgress: opts.onBatchProgress,
    }),
    consumeBatch: batch => consumeQueueBatch({
      batch,
      repository,
      store,
      registry: opts.registry,
      createJobContext: opts.createJobContext,
      dispatchOnFinish,
      onBatchProgress: opts.onBatchProgress,
      retryDelaySeconds: opts.retryDelaySeconds,
      isDlqQueue: opts.isDlqQueue,
      isDuplicate,
      onLog: opts.onLog,
    }),
    prune: pruneOpts => pruneDurableJobs(repository, pruneOpts),
  }
}
