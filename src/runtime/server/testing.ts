import type { JobRegistryLike } from './dispatch'
import type { DurableJobContinuations, DurableJobContinuationStage } from './outbox'
import type { AnyJobDefinition, JobNameOf, JobPayloadByName } from './registry'
import type { CloudflareQueue, DispatchResult, JobContext, QueueBatch, QueueBindingsConfig, QueueMessage } from './types'
import { dispatchRegisteredJob } from './dispatch'
import { resolveCloudflareQueueName } from './queue'

export interface FakeQueuedMessage<T> {
  body: T
  opts?: { delaySeconds?: number }
}

export function createFakeQueue<T = unknown>() {
  const messages: Array<FakeQueuedMessage<T>> = []
  const queue: CloudflareQueue<T> = {
    async send(message, opts) {
      messages.push({ body: message, opts })
    },
    async sendBatch(batch, opts) {
      for (const message of batch) {
        const perMessage = (message.delaySeconds !== undefined || message.contentType !== undefined)
          ? { delaySeconds: message.delaySeconds, contentType: message.contentType }
          : undefined
        messages.push({ body: message.body, opts: perMessage ?? opts })
      }
    },
  }

  return {
    queue,
    messages,
    clear() {
      messages.length = 0
    },
  }
}

export function createFakeQueueEnv<T = unknown>(binding = 'QUEUE') {
  const fake = createFakeQueue<T>()
  return {
    env: { [binding]: fake.queue },
    ...fake,
  }
}

export function createQueueMessage<T>(body: T, attempts = 0, id?: string): QueueMessage<T> & {
  acked: boolean
  retries: Array<{ delaySeconds?: number } | undefined>
} {
  return {
    id,
    body,
    attempts,
    acked: false,
    retries: [],
    ack() {
      this.acked = true
    },
    retry(opts) {
      this.retries.push(opts)
    },
  }
}

export function createQueueBatch<T>(queue: string, bodies: T[], opts?: { ids?: string[] }): QueueBatch<T> & {
  ackedAll: boolean
  retriedAll: Array<{ delaySeconds?: number } | undefined>
} {
  const messages = bodies.map((body, i) => createQueueMessage(body, 0, opts?.ids?.[i]))
  const batch = {
    queue,
    messages,
    ackedAll: false,
    retriedAll: [] as Array<{ delaySeconds?: number } | undefined>,
    ackAll() {
      batch.ackedAll = true
      for (const message of messages) message.ack()
    },
    retryAll(retryOpts: { delaySeconds?: number } | undefined) {
      batch.retriedAll.push(retryOpts)
      for (const message of messages) message.retry(retryOpts)
    },
  }
  return batch
}

// --- High-level test harness -------------------------------------------------
// Laravel-style ergonomics for consumers: run a registered job's handler inline
// (the `sync` driver), record dispatched messages with `assertSent*` helpers,
// and drain a durable outbox once. Built entirely on the existing fakes +
// `dispatchRegisteredJob`, so it needs no running queue or worker.

/**
 * Minimal registry shape the harness needs. The real `defineJobRegistry`
 * result satisfies this; `Jobs` carries the typed name/payload map.
 */
export interface TestableJobRegistry<Jobs extends readonly AnyJobDefinition[]> {
  jobs: Jobs
  getHandler: JobRegistryLike<any, any, any>['getHandler']
  loadJobDefinition?: JobRegistryLike<any, any, any>['loadJobDefinition']
  getJobDefinition?: JobRegistryLike<any, any, any>['getJobDefinition']
  getJobQueue: (name: string) => string | undefined
  buildPayload: <Name extends JobNameOf<Jobs>>(
    name: Name,
    payload: JobPayloadByName<Jobs, Name>,
  ) => { _task: Name } & Record<string, unknown>
}

export interface JobTestHarnessOptions<Env, Db, Logger> {
  /** Default `ctx.env` for every inline run. Override per-call via `runInline`. */
  env?: Env
  /** Default `ctx.db`. */
  db?: Db
  /** Default `ctx.log` (e.g. console, or a capturing spy). */
  log?: Logger
}

export interface InlineRunOptions<Env, Db, Logger> {
  /** Stable job id passed to `ctx.jobId` (defaults to a per-run counter). */
  jobId?: string
  /** `ctx.attempt` — bump this to exercise retry/backoff branches. */
  attempt?: number
  /** `ctx.batchId`. */
  batchId?: string | null
  env?: Env
  db?: Db
  log?: Logger
}

/**
 * Result of an inline run. `released`/`failed` reflect the handler calling
 * `ctx.release()` / `ctx.fail()`. Unhandled errors propagate (like `dispatchSync`).
 */
export interface InlineRunResult extends DispatchResult {
  released: boolean
  failed: boolean
  delaySeconds?: number
}

export interface SentJobMessage {
  body: { _task?: string, _continuations?: DurableJobContinuations } & Record<string, unknown>
  opts?: { delaySeconds?: number }
  binding: string
  /**
   * Identifies the `sendBatch` call this message belonged to (0-indexed across
   * the recorder's lifetime). `undefined` for messages sent via a plain `send`.
   */
  batch?: number
}

export interface FakeJobsRecorder<Jobs extends readonly AnyJobDefinition[]> {
  /** `{ [binding]: queue }` to spread into the env your producer reads from. */
  env: Record<string, CloudflareQueue<unknown>>
  /** All captured sends, in order. */
  messages: SentJobMessage[]
  clear: () => void
  assertSent: <Name extends JobNameOf<Jobs>>(
    name: Name,
    predicate?: (payload: JobPayloadByName<Jobs, Name>, message: SentJobMessage) => boolean,
  ) => void
  assertNotSent: (name: JobNameOf<Jobs>) => void
  assertSentTimes: (name: JobNameOf<Jobs>, times: number) => void
  assertSentOn: <Name extends JobNameOf<Jobs>>(
    queue: string,
    name: Name,
    predicate?: (payload: JobPayloadByName<Jobs, Name>, message: SentJobMessage) => boolean,
  ) => void
  assertNothingSent: () => void
  /**
   * Laravel-style `delay` assertion. Passing `delaySeconds` requires that exact
   * delay; omitting it just requires *some* delay to have been set.
   */
  assertSentWithDelay: (name: JobNameOf<Jobs>, delaySeconds?: number) => void
  /**
   * Asserts a sent job carries a continuation chain (Laravel's
   * `assertPushedWithChain`). `expectedChain` is the ordered list of follow-up
   * job names; defaults to the `then` (success) stage.
   */
  assertChained: (
    name: JobNameOf<Jobs>,
    expectedChain: Array<JobNameOf<Jobs>>,
    stage?: DurableJobContinuationStage,
  ) => void
  /**
   * Asserts a `sendBatch` dispatched a group of jobs together (Laravel's
   * `Bus::assertBatched`). The predicate receives every job name in one batch;
   * omit it to assert that any batch was sent.
   */
  assertBatched: (predicate?: (jobNames: string[], messages: SentJobMessage[]) => boolean) => void
}

export interface DrainOutboxOptions<Record_> {
  /** Returns the next claimable durable record, or `undefined` when drained. */
  next: () => Promise<Record_ | undefined> | Record_ | undefined
  /**
   * Extracts the `{ _task, ...payload }` envelope from a record.
   * Defaults to `JSON.parse(record.payload)`.
   */
  parsePayload?: (record: Record_) => { _task?: string } & Record<string, unknown>
  onComplete: (record: Record_, result: InlineRunResult) => void | Promise<void>
  onReleased?: (record: Record_, delaySeconds: number | undefined, result: InlineRunResult) => void | Promise<void>
  onFailed?: (record: Record_, error: unknown, result?: InlineRunResult) => void | Promise<void>
  /** Safety cap so a misbehaving `next()` can't loop forever (default 1000). */
  maxJobs?: number
}

export interface DrainOutboxResult {
  processed: number
  completed: number
  released: number
  failed: number
}

export interface JobTestHarness<Jobs extends readonly AnyJobDefinition[], Env, Db, Logger> {
  /**
   * Runs a registered job's handler inline (middleware + handle), like
   * Laravel's `sync` driver. Returns the dispatch result; unhandled throws propagate.
   */
  runInline: <Name extends JobNameOf<Jobs>>(
    name: Name,
    payload: JobPayloadByName<Jobs, Name>,
    opts?: InlineRunOptions<Env, Db, Logger>,
  ) => Promise<InlineRunResult>
  /** A recording fake queue + `assertSent*` helpers. */
  fakeJobs: (bindings?: string[]) => FakeJobsRecorder<Jobs>
  /** Claims and runs durable outbox records one at a time until drained. */
  drainOutbox: <Record_>(opts: DrainOutboxOptions<Record_>) => Promise<DrainOutboxResult>
  /**
   * Asserts a job's handler ran (and succeeded) at least once via `runInline`
   * or `drainOutbox`. Optional predicate inspects the run result.
   */
  assertRan: (name: JobNameOf<Jobs>, predicate?: (result: InlineRunResult) => boolean) => void
  /** Asserts a job's handler called `ctx.fail()` (or threw) during a run. */
  assertFailed: (name: JobNameOf<Jobs>) => void
  /** Asserts a job's handler called `ctx.release()` during a run. */
  assertReleased: (name: JobNameOf<Jobs>) => void
  /** Asserts no run failed (Laravel's `assertNothingFailed`). */
  assertNothingFailed: () => void
}

export function createJobTestHarness<
  Jobs extends readonly AnyJobDefinition[],
  Env = Record<string, unknown>,
  Db = unknown,
  Logger = unknown,
>(
  registry: TestableJobRegistry<Jobs>,
  options: JobTestHarnessOptions<Env, Db, Logger> = {},
): JobTestHarness<Jobs, Env, Db, Logger> {
  let counter = 0
  const runLog: Array<{ name: string, result: InlineRunResult }> = []

  async function dispatchEnvelope(
    envelope: { _task?: string } & Record<string, unknown>,
    opts: InlineRunOptions<Env, Db, Logger> & { queue?: string } = {},
  ): Promise<InlineRunResult> {
    const taskName = typeof envelope._task === 'string' ? envelope._task : '(unknown)'
    const control = { released: false, failed: false, delaySeconds: undefined as number | undefined }
    const result = await dispatchRegisteredJob({
      registry: registry as unknown as JobRegistryLike<Env, Db, Logger>,
      job: {
        id: opts.jobId ?? `test_${++counter}`,
        queue: opts.queue ?? 'default',
        payload: envelope,
        attempts: opts.attempt ?? 1,
        batchId: opts.batchId ?? null,
      },
      createContext: ({ control: dispatchControl }): JobContext<Env, Db, Logger> => ({
        env: (opts.env ?? options.env ?? {}) as Env,
        db: (opts.db ?? options.db) as Db,
        log: (opts.log ?? options.log) as Logger,
        jobId: opts.jobId ?? `test_${counter}`,
        batchId: opts.batchId ?? null,
        attempt: opts.attempt ?? 1,
        async release(delaySeconds) {
          control.released = true
          control.delaySeconds = delaySeconds
          dispatchControl.handled = true
          dispatchControl.action = 'released'
          dispatchControl.delaySeconds = delaySeconds
        },
        async fail(error) {
          control.failed = true
          dispatchControl.handled = true
          dispatchControl.action = 'failed'
          dispatchControl.error = error
        },
      }),
    }).catch((error: unknown) => {
      // Record unhandled throws as a failed run so `assertFailed` sees them too,
      // then re-propagate (matching `dispatchSync`).
      const failure: InlineRunResult = { success: false, released: false, failed: true, error: String(error) }
      runLog.push({ name: taskName, result: failure })
      throw error
    })
    const outcome: InlineRunResult = { ...result, released: control.released, failed: control.failed, delaySeconds: control.delaySeconds }
    runLog.push({ name: taskName, result: outcome })
    return outcome
  }

  return {
    async runInline(name, payload, opts) {
      const envelope = registry.buildPayload(name, payload)
      return dispatchEnvelope(envelope, { ...opts, queue: registry.getJobQueue(name) ?? 'default' })
    },

    fakeJobs(bindings = ['QUEUE']) {
      const messages: SentJobMessage[] = []
      const env: Record<string, CloudflareQueue<unknown>> = {}
      let batchCounter = 0
      for (const binding of bindings) {
        const fake = createFakeQueue()
        env[binding] = fake.queue
        // Re-point pushes into the shared, binding-tagged log.
        const inner = fake.queue
        env[binding] = {
          async send(message, sendOpts) {
            await inner.send(message, sendOpts)
            const last = fake.messages[fake.messages.length - 1]
            messages.push({ body: last.body as SentJobMessage['body'], opts: last.opts, binding })
          },
          async sendBatch(batch, sendOpts) {
            const before = fake.messages.length
            await inner.sendBatch(batch, sendOpts)
            const batchId = batchCounter++
            for (const m of fake.messages.slice(before))
              messages.push({ body: m.body as SentJobMessage['body'], opts: m.opts, binding, batch: batchId })
          },
        }
      }

      const matching = (name: string) => messages.filter(m => m.body?._task === name)
      const payloadOf = (m: SentJobMessage) => {
        const { _task, _continuations, ...rest } = m.body
        return rest
      }

      return {
        env,
        messages,
        clear() {
          messages.length = 0
        },
        assertSent(name, predicate) {
          const hits = matching(name).filter(m => !predicate || predicate(payloadOf(m) as never, m))
          if (hits.length === 0)
            throw new Error(`Expected job '${name}' to have been sent${predicate ? ' matching the predicate' : ''}, but it was not.`)
        },
        assertNotSent(name) {
          if (matching(name).length > 0)
            throw new Error(`Expected job '${name}' not to have been sent, but it was sent ${matching(name).length} time(s).`)
        },
        assertSentTimes(name, times) {
          const actual = matching(name).length
          if (actual !== times)
            throw new Error(`Expected job '${name}' to have been sent ${times} time(s), but it was sent ${actual} time(s).`)
        },
        assertSentOn(queue, name, predicate) {
          const jobQueue = registry.getJobQueue(name)
          if (jobQueue !== queue)
            throw new Error(`Expected job '${name}' to route to queue '${queue}', but it routes to '${jobQueue}'.`)
          const hits = matching(name).filter(m => !predicate || predicate(payloadOf(m) as never, m))
          if (hits.length === 0)
            throw new Error(`Expected job '${name}' to have been sent on queue '${queue}'${predicate ? ' matching the predicate' : ''}, but it was not.`)
        },
        assertNothingSent() {
          if (messages.length > 0)
            throw new Error(`Expected no jobs to have been sent, but ${messages.length} message(s) were sent.`)
        },
        assertSentWithDelay(name, delaySeconds) {
          const hits = matching(name).filter(m =>
            delaySeconds === undefined ? m.opts?.delaySeconds !== undefined : m.opts?.delaySeconds === delaySeconds,
          )
          if (hits.length === 0) {
            const detail = delaySeconds === undefined ? 'with a delay' : `with a ${delaySeconds}s delay`
            throw new Error(`Expected job '${name}' to have been sent ${detail}, but it was not.`)
          }
        },
        assertChained(name, expectedChain, stage = 'then') {
          const hit = matching(name).find((m) => {
            const chain = (m.body._continuations?.[stage] ?? []).map(c => c.name)
            return chain.length === expectedChain.length && chain.every((n, i) => n === expectedChain[i])
          })
          if (!hit) {
            const seen = matching(name).map(m => (m.body._continuations?.[stage] ?? []).map(c => c.name))
            throw new Error(`Expected job '${name}' to have been sent with a '${stage}' chain of [${expectedChain.join(', ')}], but saw ${JSON.stringify(seen)}.`)
          }
        },
        assertBatched(predicate) {
          const batches = new Map<number, SentJobMessage[]>()
          for (const m of messages) {
            if (m.batch === undefined)
              continue
            const group = batches.get(m.batch) ?? []
            group.push(m)
            batches.set(m.batch, group)
          }
          for (const group of batches.values()) {
            const names = group.map(m => m.body._task ?? '(unknown)')
            if (!predicate || predicate(names, group))
              return
          }
          throw new Error(`Expected a batch of jobs to have been sent${predicate ? ' matching the predicate' : ''}, but none did.`)
        },
      }
    },

    async drainOutbox(opts) {
      const parse = opts.parsePayload ?? ((record: any) => JSON.parse(record.payload))
      const max = opts.maxJobs ?? 1000
      const summary: DrainOutboxResult = { processed: 0, completed: 0, released: 0, failed: 0 }

      for (let i = 0; i < max; i++) {
        const record = await opts.next()
        if (!record)
          break
        summary.processed++
        const envelope = parse(record)
        const result = await dispatchEnvelope(envelope).catch(async (error) => {
          summary.failed++
          await opts.onFailed?.(record, error)
          return null
        })
        if (!result)
          continue

        if (result.failed) {
          summary.failed++
          await opts.onFailed?.(record, result.control?.error, result)
        }
        else if (result.released) {
          summary.released++
          await opts.onReleased?.(record, result.delaySeconds, result)
        }
        else if (result.success) {
          summary.completed++
          await opts.onComplete(record, result)
        }
        else {
          summary.failed++
          await opts.onFailed?.(record, result.error, result)
        }
      }

      return summary
    },

    assertRan(name, predicate) {
      const hits = runLog.filter(r => r.name === name && r.result.success && (!predicate || predicate(r.result)))
      if (hits.length === 0)
        throw new Error(`Expected job '${name}' to have run successfully${predicate ? ' matching the predicate' : ''}, but it did not.`)
    },
    assertFailed(name) {
      if (!runLog.some(r => r.name === name && r.result.failed))
        throw new Error(`Expected job '${name}' to have failed, but it did not.`)
    },
    assertReleased(name) {
      if (!runLog.some(r => r.name === name && r.result.released))
        throw new Error(`Expected job '${name}' to have been released, but it was not.`)
    },
    assertNothingFailed() {
      const failed = runLog.filter(r => r.result.failed)
      if (failed.length > 0)
        throw new Error(`Expected no jobs to have failed, but ${failed.map(r => r.name).join(', ')} did.`)
    },
  }
}

// --- Queue work harness (queue:work + Bus, deterministic) --------------------
// Drives the FULL pipeline in-process: producer `send` -> in-memory queue with a
// virtual clock -> consumer -> handler -> ack/retry/backoff redelivery. This is
// the Laravel `queue:work` + `Bus` equivalent: dispatch jobs, `work()` a pass
// like `queue:work --once`, `advanceTime()` to fire delayed/released retries,
// and assert lifecycle outcomes — all deterministic (no real timers).
//
// Default mode dispatches each message through the registry via an inner
// `createJobTestHarness`, so processed/failed/released assertions reuse its run
// log. Pass a custom `consumer` (an app's real batch processor) to drive YOUR
// consumer instead; then processed/failed come from your durable store, and the
// harness records queue mechanics (retried/dispatched/pending) for assertions.

export interface QueuedMessageInfo {
  /** Stable per-message id (survives redelivery). */
  id: string
  /** Task name (`_task`) or, for id-only durable messages, the `jobId`. */
  key: string
  cfQueue: string
  body: { _task?: string } & Record<string, unknown>
  attempts: number
  availableAt: number
}

export interface QueueWorkSummary {
  delivered: number
  acked: number
  retried: number
}

export interface QueueTestHarnessOptions<
  Jobs extends readonly AnyJobDefinition[],
  Env,
  Db,
  Logger,
> extends JobTestHarnessOptions<Env, Db, Logger> {
  registry: TestableJobRegistry<Jobs>
  /** Logical-queue -> binding map (same shape as `cfJobs.queues`). */
  queues: QueueBindingsConfig
  /**
   * Custom batch consumer (e.g. an app's real `cloudflare:queue` processor).
   * When omitted, the harness dispatches each message through the registry and
   * drives ack/retry from the result.
   */
  consumer?: (batch: QueueBatch, env: Env) => Promise<void> | void
  /** Backoff/DLQ cap for redelivered messages (default 3). */
  maxAttempts?: number
}

export interface QueueTestHarness<
  Jobs extends readonly AnyJobDefinition[],
  Env,
  Db,
  Logger,
> {
  /** Inner job harness: `runInline` / `fakeJobs` / `drainOutbox` + run-log asserts. */
  jobs: JobTestHarness<Jobs, Env, Db, Logger>
  /** `{ ...env, [binding]: CloudflareQueue }` — spread into producer code under test. */
  env: Env & Record<string, CloudflareQueue<unknown>>
  /** Enqueue directly onto a binding, bypassing producer code. */
  send: (binding: string, body: Record<string, unknown>, opts?: { delaySeconds?: number }) => void
  /** Process every message due at the current virtual time (one `queue:work --once` pass). */
  work: () => Promise<QueueWorkSummary>
  /** Advance the virtual clock so delayed / released / backoff messages become due. */
  advanceTime: (seconds: number) => void
  /** Drain the queue, jumping the clock to each next-due message (incl. retries + continuations). */
  runUntilEmpty: (opts?: { maxRounds?: number }) => Promise<QueueWorkSummary>
  /** Messages still queued (delivered-and-redelivered or scheduled for the future). */
  pending: () => QueuedMessageInfo[]
  /** A job's handler ran and succeeded (default-consumer mode). */
  assertProcessed: (name: JobNameOf<Jobs>, predicate?: (result: InlineRunResult) => boolean) => void
  /** A job's handler called `ctx.fail()` or threw (default-consumer mode). */
  assertFailed: (name: JobNameOf<Jobs>) => void
  /** A job called `ctx.release()`; `opts.delay` additionally checks the backoff. */
  assertReleased: (name: JobNameOf<Jobs>, opts?: { delay?: number }) => void
  /** A message (by task name or `jobId`) was retried/redelivered exactly `times`. */
  assertRetried: (key: string, times: number) => void
  /** A message (by task name or `jobId`) was ever enqueued. */
  assertDispatched: (key: string) => void
  /** Nothing remains queued. */
  assertNothingPending: () => void
}

export function createQueueTestHarness<
  Jobs extends readonly AnyJobDefinition[],
  Env = Record<string, unknown>,
  Db = unknown,
  Logger = unknown,
>(
  options: QueueTestHarnessOptions<Jobs, Env, Db, Logger>,
): QueueTestHarness<Jobs, Env, Db, Logger> {
  const { queues, maxAttempts = 3 } = options

  let now = 0
  let counter = 0
  let ackedCount = 0
  const queue: QueuedMessageInfo[] = []
  const retries: Array<{ key: string, delay: number }> = []
  const dispatched: string[] = []
  const dlq: string[] = []

  const keyOf = (body: Record<string, unknown>): string =>
    typeof body._task === 'string' ? body._task : typeof body.jobId === 'string' ? body.jobId : '(unknown)'

  function enqueue(cfQueue: string, body: Record<string, unknown>, delaySeconds: number, attempts: number, id?: string) {
    const info: QueuedMessageInfo = {
      id: id ?? `m${++counter}`,
      key: keyOf(body),
      cfQueue,
      body,
      attempts,
      availableAt: now + Math.max(0, delaySeconds),
    }
    queue.push(info)
    dispatched.push(info.key)
  }

  // Build producer bindings: env[binding].send/sendBatch enqueue onto the
  // matching CF queue name (what `batch.queue` carries for the consumer).
  const env = { ...(options.env as Env) } as Env & Record<string, CloudflareQueue<unknown>>
  for (const [logical, config] of Object.entries(queues)) {
    const binding = typeof config === 'string' ? config : config?.binding
    if (!binding)
      continue
    const cfQueue = resolveCloudflareQueueName(queues, logical)
    ;(env as Record<string, CloudflareQueue<unknown>>)[binding] = {
      async send(body, opts) {
        enqueue(cfQueue, body as Record<string, unknown>, opts?.delaySeconds ?? 0, 1)
      },
      async sendBatch(messages, opts) {
        for (const message of messages)
          enqueue(cfQueue, message.body as Record<string, unknown>, message.delaySeconds ?? opts?.delaySeconds ?? 0, 1)
      },
    }
  }

  // Inner job harness drives the default-consumer dispatch + lifecycle run log.
  // It gets the augmented `env` so handlers can enqueue continuations onto the
  // producer bindings during a run.
  const jobs = createJobTestHarness(options.registry, { ...options, env })

  function makeMessage(info: QueuedMessageInfo): QueueMessage {
    let settled = false
    return {
      id: info.id,
      body: info.body,
      attempts: info.attempts,
      timestamp: now,
      ack() {
        if (settled)
          return
        settled = true
        ackedCount++
      },
      retry(opts) {
        if (settled)
          return
        settled = true
        const delay = opts?.delaySeconds ?? 0
        if (info.attempts >= maxAttempts) {
          dlq.push(info.key)
          return
        }
        retries.push({ key: info.key, delay })
        enqueue(info.cfQueue, info.body, delay, info.attempts + 1, info.id)
      },
    }
  }

  async function defaultConsumer(batch: QueueBatch) {
    for (const message of batch.messages) {
      const body = message.body as { _task?: string } & Record<string, unknown>
      if (typeof body._task !== 'string') {
        message.retry()
        continue
      }
      const { _task, _continuations, ...payload } = body
      try {
        const result = await jobs.runInline(_task as JobNameOf<Jobs>, payload as never, {
          jobId: message.id,
          attempt: message.attempts,
        })
        if (result.released)
          message.retry({ delaySeconds: result.delaySeconds })
        else
          message.ack() // success or permanent ctx.fail() / invalid payload
      }
      catch {
        message.retry() // unhandled throw → transient redelivery
      }
    }
  }

  const consumer = options.consumer
    ? (batch: QueueBatch) => options.consumer!(batch, env)
    : defaultConsumer

  // The lifecycle asserts read the inline run log, which only the default
  // consumer populates. Fail loudly (not misleadingly) if used with a custom one.
  function ensureDefaultConsumer(method: string) {
    if (options.consumer) {
      throw new Error(
        `${method}() only works with the default consumer (it reads the inline run log). `
        + `With a custom consumer, assert outcomes via your durable store, or use `
        + `assertRetried() / assertDispatched() / pending().`,
      )
    }
  }

  async function work(): Promise<QueueWorkSummary> {
    const due = queue.filter(m => m.availableAt <= now)
    if (due.length === 0)
      return { delivered: 0, acked: 0, retried: 0 }

    for (const d of due)
      queue.splice(queue.indexOf(d), 1)

    const groups = new Map<string, QueuedMessageInfo[]>()
    for (const d of due)
      groups.set(d.cfQueue, [...(groups.get(d.cfQueue) ?? []), d])

    const ackedBefore = ackedCount
    const retriedBefore = retries.length
    for (const [cfQueue, items] of groups) {
      const messages = items.map(makeMessage)
      const batch: QueueBatch = {
        queue: cfQueue,
        messages,
        ackAll() {
          for (const m of messages) m.ack()
        },
        retryAll(opts) {
          for (const m of messages) m.retry(opts)
        },
      }
      await consumer(batch)
    }

    return { delivered: due.length, acked: ackedCount - ackedBefore, retried: retries.length - retriedBefore }
  }

  return {
    jobs,
    env,
    send(binding, body, opts) {
      const cfQueue = resolveCloudflareQueueName(queues, bindingLogical(queues, binding) ?? binding)
      enqueue(cfQueue, body, opts?.delaySeconds ?? 0, 1)
    },
    work,
    advanceTime(seconds) {
      now += Math.max(0, seconds)
    },
    async runUntilEmpty(opts) {
      const total: QueueWorkSummary = { delivered: 0, acked: 0, retried: 0 }
      const maxRounds = opts?.maxRounds ?? 100
      for (let round = 0; round < maxRounds; round++) {
        if (!queue.some(m => m.availableAt <= now)) {
          let next = Infinity
          for (const m of queue) next = Math.min(next, m.availableAt)
          if (next === Infinity)
            break
          now = next
        }
        const summary = await work()
        total.delivered += summary.delivered
        total.acked += summary.acked
        total.retried += summary.retried
      }
      return total
    },
    pending() {
      return queue.map(m => ({ ...m }))
    },
    assertProcessed(name, predicate) {
      ensureDefaultConsumer('assertProcessed')
      jobs.assertRan(name, predicate)
    },
    assertFailed(name) {
      ensureDefaultConsumer('assertFailed')
      jobs.assertFailed(name)
    },
    assertReleased(name, opts) {
      ensureDefaultConsumer('assertReleased')
      jobs.assertReleased(name)
      if (opts?.delay !== undefined && !retries.some(r => r.key === name && r.delay === opts.delay))
        throw new Error(`Expected job '${name}' to have been released with a ${opts.delay}s delay, but it was not.`)
    },
    assertRetried(key, times) {
      const actual = retries.filter(r => r.key === key).length
      if (actual !== times)
        throw new Error(`Expected '${key}' to have been retried ${times} time(s), but it was retried ${actual} time(s).`)
    },
    assertDispatched(key) {
      if (!dispatched.includes(key))
        throw new Error(`Expected '${key}' to have been dispatched onto a queue, but it was not.`)
    },
    assertNothingPending() {
      if (queue.length > 0)
        throw new Error(`Expected nothing pending, but ${queue.length} message(s) remain: ${queue.map(m => m.key).join(', ')}.`)
    },
  }
}

/** Reverse-lookup the logical queue name for a binding (for `send(binding, …)`). */
function bindingLogical(queues: QueueBindingsConfig, binding: string): string | undefined {
  for (const [logical, config] of Object.entries(queues)) {
    if ((typeof config === 'string' ? config : config?.binding) === binding)
      return logical
  }
  return undefined
}
