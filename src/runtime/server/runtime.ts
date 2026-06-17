import type { BatchProgress, CreateJobBatchOptions, CreateJobBatchResult, DurableBatchStore, SettleBatchMemberOptions, SettleBatchMemberResult } from './batch'
import type { CfJobsBroadcastOptions, CfJobsRuntimeBroadcastOptions } from './broadcast'
import type { D1DatabaseLike, D1DurableJobRecord, D1DurableJobRepository, D1DurableJobRepositoryOptions } from './d1'
import type { JobMetricsSink } from './metrics'
import type {
  DurableJobContinuation,
  DurableJobContinuationStage,
  DurableJobRecord,
  DurableJobScope,
  EnqueueDurableJobResult,
  PruneDurableJobsOptions,
  PruneDurableJobsResult,
  QueuePublisher,
  RunDurableJobMessageOptions,
  RunDurableJobMessageResult,
} from './outbox'
import type { DispatchableJob, JobDefinition, JobHandler, QueueBatch, QueueMessage } from './types'
import { createD1DurableBatchStore, createJobBatch, settleBatchMember } from './batch'
import { createCfJobsBroadcastBatchProgressHandler, createCfJobsBroadcastRepositoryHooks } from './broadcast'
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

  const terminal = run.status === 'completed' || run.status === 'failed' || run.status === 'dispatch-failed' || run.status === 'exhausted'
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
  completeResult?: RunDurableJobMessageOptions<D1DurableJobRecord<Queue>, DispatchableJob, { jobId: string, queue: string }, Env, Db, Logger>['completeResult']
  /** Defaults to a `-dlq` suffix check. */
  isDlqQueue?: (queue: string) => boolean
  isDuplicate?: (id: string | undefined) => boolean
  onLog?: (event: { stage: string, queue?: string, taskName?: string, jobId?: string, error?: string }) => void
  // ── per-job hooks (durable path) — forwarded to runDurableJobMessage ──
  createJobScope?: (storedJob: D1DurableJobRecord<Queue>) => DurableJobScope<D1DurableJobRecord<Queue>>
  isPermanentFailure?: (input: { error: unknown, storedJob: D1DurableJobRecord<Queue>, attempts: number, maxAttempts: number | undefined }) => boolean
  dispatchContinuations?: (input: { storedJob: D1DurableJobRecord<Queue>, stage: DurableJobContinuationStage }) => void | Promise<void>
  /**
   * Soft batch CPU budget (ms). Before each message, if the batch has run longer
   * than this, the remaining messages are retried instead of processed — so a
   * heavy batch can't blow the Worker CPU limit mid-message.
   */
  maxBatchCpuMs?: number
  /** Delay (s) for messages deferred by the CPU guard. Default 5. */
  cpuGuardRetryDelaySeconds?: number
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
        // Laravel's "exhausted → failed_jobs" transition. Claim FIRST: only when
        // the claim succeeds do WE own the terminal transition, so we failJob
        // (move out of `jobs` — no leak, no sweep re-dispatch) and settle exactly
        // once. A claim MISS means the row is already terminal, which means the
        // path that made it terminal (the consumer's fail/exhausted branch, or a
        // duplicate DLQ delivery) already settled it — settling again would
        // double-decrement `pending_jobs` and fire onFinish early.
        const claimed = await opts.repository.claimJob(jobId).catch(() => null)
        if (claimed) {
          await opts.repository.failJob(claimed, 'Exhausted retries (dead-letter queue)').catch(() => {})
          await settleBatchMember({ store: opts.store, jobId, failed: true, dispatchOnFinish: opts.dispatchOnFinish })
            .then(r => r.progress && opts.onBatchProgress ? opts.onBatchProgress(r.progress) : undefined)
            .catch(() => {})
        }
      }
      message.ack()
    }
    return
  }

  const batchStartedMs = Date.now()
  const cpuBudget = opts.maxBatchCpuMs
  for (const message of opts.batch.messages) {
    // CPU guard: defer the rest of the batch once we've burned the budget.
    if (cpuBudget != null && Date.now() - batchStartedMs > cpuBudget) {
      message.retry({ delaySeconds: opts.cpuGuardRetryDelaySeconds ?? 5 })
      continue
    }

    const body = (message.body ?? {}) as Record<string, unknown>
    const jobId = typeof body.jobId === 'string' ? body.jobId : undefined
    if (jobId) {
      await runDurableJobBatchMessage({
        message: message as unknown as ConsumerMessage,
        lifecycle: opts.repository,
        registry: opts.registry,
        store: opts.store,
        toDispatchableJob: opts.repository.toDispatchableJob,
        createJobContext: opts.createJobContext,
        retryDelaySeconds: opts.retryDelaySeconds,
        completeResult: opts.completeResult,
        // Honour the stored job's attempt cap (Laravel worker model).
        maxAttemptsOf: stored => stored.max_attempts,
        createJobScope: opts.createJobScope,
        isPermanentFailure: opts.isPermanentFailure,
        dispatchContinuations: opts.dispatchContinuations,
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
  /** May resolve async for lazily-loaded jobs (dispatchRegisteredJob awaits it). */
  getHandler: (name: string) => JobHandler<unknown, Env, Db, Logger> | undefined | Promise<JobHandler<unknown, Env, Db, Logger> | undefined>
  loadJobDefinition?: (name: string) => Promise<JobDefinition<string, unknown, string, Env, Db, Logger> | undefined>
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
  /**
   * Broadcast job lifecycle + batch progress over Nitro WebSockets via Nitro's
   * Cloudflare Durable Object publisher. Pass `true` for defaults.
   */
  broadcast?: CfJobsRuntimeBroadcastOptions
  /** Notified after each batch settle. */
  onBatchProgress?: (progress: BatchProgress) => void | Promise<void>
  /** Optional completion payload forwarded to `completeJob` and broadcast result. */
  completeResult?: RunDurableJobMessageOptions<D1DurableJobRecord<Queue>, DispatchableJob, { jobId: string, queue: string }, Env, Db, Logger>['completeResult']
  /** Override how a batch's onFinish continuation runs (default: durable enqueue). */
  dispatchOnFinish?: SettleBatchMemberOptions['dispatchOnFinish']
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
  // ── per-job hooks (durable path) ──
  /** Per-job scope: wrap dispatch (e.g. telemetry) + observe each settlement. */
  createJobScope?: (storedJob: D1DurableJobRecord<Queue>) => DurableJobScope<D1DurableJobRecord<Queue>>
  /** Decide whether a thrown error is terminal (default: attempts >= max). */
  isPermanentFailure?: (input: { error: unknown, storedJob: D1DurableJobRecord<Queue>, attempts: number, maxAttempts: number | undefined }) => boolean
  /** Dispatch then/catch/finally payload continuations after a terminal outcome. */
  dispatchContinuations?: (input: { storedJob: D1DurableJobRecord<Queue>, stage: DurableJobContinuationStage }) => void | Promise<void>
  /** Soft per-batch CPU budget (ms); remaining messages are deferred once exceeded. */
  maxBatchCpuMs?: number
  /** Delay (s) for CPU-guard-deferred messages. Default 5. */
  cpuGuardRetryDelaySeconds?: number
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

type D1LifecycleHooks<Queue extends string> = Pick<D1DurableJobRepositoryOptions<Queue>, 'onJobClaimed' | 'onJobCompleted' | 'onJobFailed' | 'onJobReleased'>

function resolveBroadcastOptions(input: CfJobsRuntimeBroadcastOptions | undefined): CfJobsBroadcastOptions | null {
  if (!input)
    return null
  return input === true ? {} : input
}

function composeLifecycleHooks<Queue extends string>(
  ...sets: Array<Partial<D1LifecycleHooks<Queue>> | undefined>
): D1LifecycleHooks<Queue> {
  return {
    onJobClaimed: composeHook(sets.map(s => s?.onJobClaimed)),
    onJobCompleted: composeHook(sets.map(s => s?.onJobCompleted)),
    onJobFailed: composeHook(sets.map(s => s?.onJobFailed)),
    onJobReleased: composeHook(sets.map(s => s?.onJobReleased)),
  }
}

function composeHook<T>(hooks: Array<((input: T) => void | Promise<void>) | undefined>): (input: T) => void {
  return (input) => {
    for (const hook of hooks) {
      try {
        const result = hook?.(input)
        if (result && typeof (result as Promise<void>).then === 'function')
          (result as Promise<void>).catch(() => {})
      }
      catch {
        // Lifecycle observers must not affect job execution.
      }
    }
  }
}

function composeBatchProgress(
  broadcast: ((progress: BatchProgress) => void) | undefined,
  user: ((progress: BatchProgress) => void | Promise<void>) | undefined,
): ((progress: BatchProgress) => void | Promise<void>) | undefined {
  if (!broadcast)
    return user
  if (!user)
    return broadcast
  return async (progress) => {
    broadcast(progress)
    await user(progress)
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
  const broadcastOptions = resolveBroadcastOptions(opts.broadcast)
  const lifecycleHooks = composeLifecycleHooks(
    opts.metricsSink ? metricsSinkToRepoHooks(opts.metricsSink) : undefined,
    broadcastOptions ? createCfJobsBroadcastRepositoryHooks<Queue, Env, Db, Logger>(opts.env, broadcastOptions, { registry: opts.registry }) : undefined,
  )
  const onBatchProgress = composeBatchProgress(
    broadcastOptions ? createCfJobsBroadcastBatchProgressHandler(opts.env, broadcastOptions) : undefined,
    opts.onBatchProgress,
  )
  const repository = createD1DurableJobRepository<Queue>(opts.db, {
    reclaimAfterSeconds: opts.reclaimAfterSeconds,
    ...lifecycleHooks,
  })
  const store = createD1DurableBatchStore(opts.db)
  const publisher = createQueuePublisher<Record<string, unknown>, Queue>(
    opts.env,
    opts.resolveQueueBinding,
    { onMissingBinding: opts.onMissingBinding },
  )

  // Default onFinish: enqueue the continuation durably (survives an isolate
  // recycle, same guarantee the batch members get). This fires AFTER the batch is
  // already settled + the member message acked, so a throw here can't be retried —
  // it would silently drop the continuation (and break a parent-batch chain). So
  // it must never throw: a failed enqueue is logged via onLog and left for the
  // app's own backstop (e.g. a reconcile cron) to recover.
  const dispatchOnFinish: SettleBatchMemberOptions['dispatchOnFinish'] = opts.dispatchOnFinish ?? (async ({ continuation, batch }) => {
    const c = continuation as DurableJobContinuation
    try {
      const record = await prepareDurableJob({ name: c.name, payload: c.payload, registry: opts.registry as never })
      await enqueueDurableJob(repository, publisher, record as DurableJobRecord<Queue>)
    }
    catch (error) {
      opts.onLog?.({ stage: 'onfinish-failed', taskName: c.name, jobId: batch.id, error: error instanceof Error ? error.message : String(error) })
    }
  })

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
      maxAttemptsOf: stored => stored.max_attempts,
      completeResult: opts.completeResult,
      createJobScope: opts.createJobScope,
      isPermanentFailure: opts.isPermanentFailure,
      dispatchContinuations: opts.dispatchContinuations,
      dispatchOnFinish,
      onBatchProgress,
    }),
    consumeBatch: batch => consumeQueueBatch({
      batch,
      repository,
      store,
      registry: opts.registry,
      createJobContext: opts.createJobContext,
      dispatchOnFinish,
      onBatchProgress,
      retryDelaySeconds: opts.retryDelaySeconds,
      completeResult: opts.completeResult,
      isDlqQueue: opts.isDlqQueue,
      isDuplicate,
      onLog: opts.onLog,
      createJobScope: opts.createJobScope,
      isPermanentFailure: opts.isPermanentFailure,
      dispatchContinuations: opts.dispatchContinuations,
      maxBatchCpuMs: opts.maxBatchCpuMs,
      cpuGuardRetryDelaySeconds: opts.cpuGuardRetryDelaySeconds,
    }),
    prune: pruneOpts => pruneDurableJobs(repository, pruneOpts),
  }
}
