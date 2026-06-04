import type { BatchProgress, DurableBatchStore, SettleBatchMemberOptions, SettleBatchMemberResult } from './batch'
import type { D1DatabaseLike, D1DurableJobRepository } from './d1'
import type { JobMetricsSink } from './metrics'
import type {
  CreateJobBatchOptions,
  CreateJobBatchResult,
  DurableJobContinuation,
  DurableJobRecord,
  EnqueueDurableJobResult,
  QueuePublisher,
  RunDurableJobMessageOptions,
  RunDurableJobMessageResult,
} from './outbox'
import type { DispatchableJob, JobDefinition, JobHandler } from './types'
import { createD1DurableBatchStore, createJobBatch, settleBatchMember } from './batch'
import { createD1DurableJobRepository } from './d1'
import { metricsSinkToRepoHooks } from './metrics'
import { createQueuePublisher, enqueueDurableJob, prepareDurableJob, runDurableJobMessage } from './outbox'

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
// Runtime factory: one call → enqueue / batch / consume
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
}

export interface DurableJobsRuntime<Queue extends string = string> {
  repository: D1DurableJobRepository<Queue>
  store: DurableBatchStore
  publisher: QueuePublisher<Queue>
  /** Durably enqueue a prepared record (persist row + dispatch message). */
  enqueue: (record: DurableJobRecord<Queue>, opts?: { delaySeconds?: number }) => Promise<EnqueueDurableJobResult>
  /** Register + dispatch a batch; `onFinish` fires once every member settles. */
  createBatch: (opts: Omit<CreateJobBatchOptions<string, Record<string, unknown>, Queue>, 'store' | 'repository' | 'publisher'>) => Promise<CreateJobBatchResult>
  /** Run one queue message end-to-end (lifecycle + batch settle + progress). */
  consumeMessage: (message: ConsumerMessage) => Promise<RunDurableJobBatchMessageResult>
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
  }
}
