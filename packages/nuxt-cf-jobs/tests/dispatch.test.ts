import { getTableName } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { describe, expect, it, vi } from 'vitest'
import {
  assertJobDefinitions,
  cfFailedJobs,
  cfJobBatches,
  cfJobs,
  claimDurableJob,
  completeDurableJob,
  createD1DurableJobRepository,
  createJobQueue,
  createJobTraceId,
  createJobUniqueKey,
  createQueuePublisher,
  d1DurableJobMigrationSql,
  defineJob,
  defineJobRegistry,
  dispatchDurableJobBatch,
  dispatchDurableJobContinuations,
  dispatchRegisteredJob,
  enqueueDurableJob,
  exponentialBackoff,
  failDurableJob,
  findDispatchableDurableJobs,
  getDurableJobContinuationsForStage,
  groupQueueJobMessagesByQueue,
  jobNameFromTraceLogs,
  parseDurableJobContinuation,
  prepareDurableJob,
  prepareRegisteredDurableJob,
  releaseDurableJob,
  releaseStaleReservedDurableJobs,
  resolveJobBackoff,
  resolveJobMaxAttempts,
  resolveJobRetryDelay,
  resolveQueueBindingName,
  runDurableJobMessage,
  serializeDurableJobContinuation,
  validateJobDefinitions,
} from '#cf-jobs/server'
import {
  createFakeQueue,
  createFakeQueueEnv,
  createQueueBatch,
  createQueueMessage,
} from '#cf-jobs/testing'
// Module-private helpers (not on the public `#cf-jobs/server` surface) imported
// from their own module paths for white-box testing.
import { buildJobPayload } from '../src/runtime/server/payload'
import {
  assertJobQueueBindings,
  processRegisteredQueueBatch,
  registerRegisteredQueueConsumer,
  resolveCloudflareQueueName,
  resolveLogicalQueueName,
  resolveQueueJobType,
  sendBatchChunked,
  validateJobQueueBindings,
} from '../src/runtime/server/queue'

describe('nuxt-cf-jobs dispatch kernel', () => {
  it('dispatches a job by _task name and strips the task envelope', async () => {
    const seen: string[] = []
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/send',
        queue: 'default',
        async handle(payload: { message: string }, ctx: { log: string[] }) {
          ctx.log.push(payload.message)
          expect(payload).not.toHaveProperty('_task')
        },
      }),
    ])

    const result = await dispatchRegisteredJob({
      registry,
      job: {
        id: 'job_1',
        queue: 'default',
        attempts: 1,
        batchId: null,
        payload: buildJobPayload('demo/send', { message: 'hello' }),
      },
      createContext: () => ({
        env: {},
        db: {},
        log: seen,
        jobId: 'job_1',
        batchId: null,
        attempt: 1,
        release: vi.fn(),
        fail: vi.fn(),
      }),
    })

    expect(result).toEqual({ success: true, control: undefined })
    expect(seen).toEqual(['hello'])
  })

  it('names the job in a trace marker before the handler runs, so a killed invocation still reports it', async () => {
    const lines: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void lines.push(args.join(' ')))
    const registry = defineJobRegistry([
      defineJob({
        name: 'crawl/slice',
        queue: 'default',
        // A handler the runtime kills partway through writes nothing itself.
        async handle() {},
      }),
    ])
    const job = {
      id: 'job_marker',
      queue: 'default',
      attempts: 1,
      batchId: null,
      payload: buildJobPayload('crawl/slice', {}),
    }
    const context = () => ({
      env: {},
      db: {},
      log: [],
      jobId: 'job_marker',
      batchId: null,
      attempt: 1,
      release: vi.fn(),
      fail: vi.fn(),
    })

    await dispatchRegisteredJob({ registry, job, createContext: context, traceMarker: true })
    expect(lines).toEqual(['cfjob:crawl/slice'])
    expect(jobNameFromTraceLogs([{ message: lines }])).toBe('crawl/slice')

    // Off by default: an app that consumes no traces pays nothing.
    lines.length = 0
    await dispatchRegisteredJob({ registry, job, createContext: context })
    expect(lines).toEqual([])
    log.mockRestore()
  })

  it('recovers the job that was running from a batch that logged several markers', () => {
    // A batch delivers many messages to one invocation; the kill belongs to the last.
    expect(jobNameFromTraceLogs([
      { message: ['cfjob:crawl/slice'] },
      { message: ['some job output'] },
      { message: ['cfjob:assess/generate'] },
    ])).toBe('assess/generate')
    expect(jobNameFromTraceLogs([{ message: ['nothing to see'] }])).toBeNull()
    expect(jobNameFromTraceLogs(undefined)).toBeNull()
  })

  it('reports missing or unknown task names without calling a context factory', async () => {
    const registry = defineJobRegistry([])
    const createContext = vi.fn()

    await expect(dispatchRegisteredJob({
      registry,
      job: { id: 'job_1', queue: 'default', attempts: 1, batchId: null, payload: {} },
      createContext,
    })).resolves.toMatchObject({ success: false, error: { _tag: 'no-task', message: 'No _task in payload' } })

    await expect(dispatchRegisteredJob({
      registry,
      job: {
        id: 'job_2',
        queue: 'default',
        attempts: 1,
        batchId: null,
        payload: buildJobPayload('missing/task', {}),
      },
      createContext,
    })).resolves.toMatchObject({ success: false, error: { _tag: 'handler-not-found', task: 'missing/task', message: 'No handler for task: missing/task' } })

    expect(createContext).not.toHaveBeenCalled()
  })

  it('keeps runtime input validation coupled to the job definition', async () => {
    const input = {
      safeParse(payload: unknown) {
        return payload && typeof payload === 'object' && typeof (payload as { message?: unknown }).message === 'string'
          ? { success: true as const, data: payload as { message: string } }
          : { success: false as const, error: new Error('message is required') }
      },
    }
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/validated',
        queue: 'default',
        input,
        async handle(payload, ctx: { log: string[] }) {
          ctx.log.push(payload.message)
        },
      }),
    ])
    const seen: string[] = []

    expect(registry.buildPayload('demo/validated', { message: 'typed' })).toEqual({
      _task: 'demo/validated',
      message: 'typed',
    })

    await expect(dispatchRegisteredJob({
      registry,
      job: {
        id: 'job_1',
        queue: 'default',
        attempts: 1,
        batchId: null,
        payload: buildJobPayload('demo/validated', { missing: true }),
      },
      createContext: vi.fn(),
    })).resolves.toMatchObject({
      success: false,
      error: { _tag: 'invalid-payload', task: 'demo/validated', message: 'Invalid payload for task: demo/validated' },
    })

    await dispatchRegisteredJob({
      registry,
      job: {
        id: 'job_2',
        queue: 'default',
        attempts: 1,
        batchId: null,
        payload: registry.buildPayload('demo/validated', { message: 'hello' }),
      },
      createContext: () => ({
        env: {},
        db: {},
        log: seen,
        jobId: 'job_2',
        batchId: null,
        attempt: 1,
        release: vi.fn(),
        fail: vi.fn(),
      }),
    })

    expect(seen).toEqual(['hello'])
  })

  it('treats throws after release/fail as handled control flow', async () => {
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/release',
        queue: 'default',
        async handle(_payload: Record<string, never>, ctx: { release: (delaySeconds: number) => Promise<void> }) {
          await ctx.release(30)
          throw new Error('after release')
        },
      }),
    ])
    const onHandledThrow = vi.fn()

    const result = await dispatchRegisteredJob({
      registry,
      job: {
        id: 'job_1',
        queue: 'default',
        attempts: 1,
        batchId: null,
        payload: buildJobPayload('demo/release', {}),
      },
      createContext: ({ control }) => ({
        env: {},
        db: {},
        log: {},
        jobId: 'job_1',
        batchId: null,
        attempt: 1,
        async release(delaySeconds: number) {
          control.handled = true
          control.action = 'released'
          control.delaySeconds = delaySeconds
        },
        fail: vi.fn(),
      }),
      onHandledThrow,
    })

    expect(result).toEqual({
      success: true,
      control: { handled: true, action: 'released', delaySeconds: 30 },
    })
    expect(onHandledThrow).toHaveBeenCalledOnce()
  })

  it('runs job middleware around the handler in declaration order', async () => {
    const calls: string[] = []
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/middleware',
        queue: 'default',
        middleware: [
          async (_payload: { message: string }, _ctx: unknown, next) => {
            calls.push('first:before')
            await next()
            calls.push('first:after')
          },
          async (_payload: { message: string }, _ctx: unknown, next) => {
            calls.push('second:before')
            await next()
            calls.push('second:after')
          },
        ],
        async handle(payload: { message: string }) {
          calls.push(`handle:${payload.message}`)
        },
      }),
    ])

    await dispatchRegisteredJob({
      registry,
      job: {
        id: 'job_1',
        queue: 'default',
        attempts: 1,
        batchId: null,
        payload: buildJobPayload('demo/middleware', { message: 'hello' }),
      },
      createContext: () => ({
        env: {},
        db: {},
        log: {},
        jobId: 'job_1',
        batchId: null,
        attempt: 1,
        release: vi.fn(),
        fail: vi.fn(),
      }),
    })

    expect(calls).toEqual([
      'first:before',
      'second:before',
      'handle:hello',
      'second:after',
      'first:after',
    ])
  })

  it('allows middleware to short-circuit a job', async () => {
    const handle = vi.fn()
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/short-circuit',
        queue: 'default',
        middleware: [
          async () => {
            // Do not call next.
          },
        ],
        handle,
      }),
    ])

    await dispatchRegisteredJob({
      registry,
      job: {
        id: 'job_1',
        queue: 'default',
        attempts: 1,
        batchId: null,
        payload: buildJobPayload('demo/short-circuit', {}),
      },
      createContext: () => ({
        env: {},
        db: {},
        log: {},
        jobId: 'job_1',
        batchId: null,
        attempt: 1,
        release: vi.fn(),
        fail: vi.fn(),
      }),
    })

    expect(handle).not.toHaveBeenCalled()
  })

  it('guards against middleware calling next more than once', async () => {
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/double-next',
        queue: 'default',
        middleware: [
          async (_payload: Record<string, never>, _ctx: unknown, next) => {
            await next()
            await next()
          },
        ],
        async handle() {},
      }),
    ])

    await expect(dispatchRegisteredJob({
      registry,
      job: {
        id: 'job_1',
        queue: 'default',
        attempts: 1,
        batchId: null,
        payload: buildJobPayload('demo/double-next', {}),
      },
      createContext: () => ({
        env: {},
        db: {},
        log: {},
        jobId: 'job_1',
        batchId: null,
        attempt: 1,
        release: vi.fn(),
        fail: vi.fn(),
      }),
    })).rejects.toThrow('Job middleware called next() multiple times')
  })

  it('does not run a job-local failed hook for a retriable handler error', async () => {
    const failed = vi.fn()
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/fails',
        queue: 'default',
        async handle() {
          throw new Error('boom')
        },
        failed,
      }),
    ])

    await expect(dispatchRegisteredJob({
      registry,
      job: {
        id: 'job_1',
        queue: 'default',
        attempts: 1,
        batchId: null,
        payload: buildJobPayload('demo/fails', { message: 'hello' }),
      },
      createContext: () => ({
        env: {},
        db: {},
        log: {},
        jobId: 'job_1',
        batchId: null,
        attempt: 1,
        release: vi.fn(),
        fail: vi.fn(),
      }),
    })).rejects.toThrow('boom')

    expect(failed).not.toHaveBeenCalled()
  })

  it('dispatches registered jobs from Cloudflare queue batches by logical queue', async () => {
    const seen: string[] = []
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/queued',
        queue: 'default',
        async handle(payload: { message: string }, ctx: { log: string[] }) {
          ctx.log.push(payload.message)
        },
      }),
    ])
    const batch = createQueueBatch('cf-default', [
      buildJobPayload('demo/queued', { message: 'hello' }),
    ])

    await processRegisteredQueueBatch({
      batch,
      env: {},
    }, {
      registry,
      queues: { default: { binding: 'QUEUE_DEFAULT', queueName: 'cf-default' } },
      createContext: ({ job, message }) => ({
        env: {},
        db: {},
        log: seen,
        jobId: job.id,
        batchId: null,
        attempt: message.attempts,
        release: vi.fn(),
        fail: vi.fn(),
      }),
    })

    expect(seen).toEqual(['hello'])
    expect(batch.messages[0]?.acked).toBe(true)
  })

  it('retries registered queue messages when handlers throw', async () => {
    const error = new Error('boom')
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/fail',
        queue: 'default',
        async handle() {
          throw error
        },
      }),
    ])
    const batch = createQueueBatch('cf-default', [
      buildJobPayload('demo/fail', {}),
    ])
    const onDispatchError = vi.fn()

    await processRegisteredQueueBatch({
      batch,
      env: {},
    }, {
      registry,
      queues: { default: { binding: 'QUEUE_DEFAULT', queueName: 'cf-default' } },
      retryDelaySeconds: () => 42,
      onDispatchError,
      createContext: ({ job, message }) => ({
        env: {},
        db: {},
        log: {},
        jobId: job.id,
        batchId: null,
        attempt: message.attempts,
        release: vi.fn(),
        fail: vi.fn(),
      }),
    })

    expect(onDispatchError).toHaveBeenCalledWith(expect.objectContaining({ error, taskName: 'demo/fail' }))
    expect(batch.messages[0]?.acked).toBe(false)
    expect(batch.messages[0]?.retries).toEqual([{ delaySeconds: 42 }])
  })

  it('retries registered queue messages when handlers release', async () => {
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/release-queued',
        queue: 'default',
        async handle(_payload: Record<string, never>, ctx: { release: (delaySeconds: number) => Promise<void> }) {
          await ctx.release(17)
        },
      }),
    ])
    const batch = createQueueBatch('cf-default', [
      buildJobPayload('demo/release-queued', {}),
    ])

    await processRegisteredQueueBatch({
      batch,
      env: {},
    }, {
      registry,
      queues: { default: { binding: 'QUEUE_DEFAULT', queueName: 'cf-default' } },
      createContext: ({ control, job, message }) => ({
        env: {},
        db: {},
        log: {},
        jobId: job.id,
        batchId: null,
        attempt: message.attempts,
        async release(delaySeconds: number) {
          control.handled = true
          control.action = 'released'
          control.delaySeconds = delaySeconds
        },
        fail: vi.fn(),
      }),
    })

    expect(batch.messages[0]?.acked).toBe(false)
    expect(batch.messages[0]?.retries).toEqual([{ delaySeconds: 17 }])
  })

  it('does not dedup registered queue redeliveries until a message is terminally acked', async () => {
    let calls = 0
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/flaky-once',
        queue: 'default',
        async handle() {
          calls++
          if (calls === 1)
            throw new Error('retry me')
        },
      }),
    ])
    const opts = {
      registry,
      queues: { default: { binding: 'QUEUE_DEFAULT', queueName: 'cf-default' } },
      retryDelaySeconds: () => 1,
      createContext: ({ job, message }: { job: { id: string }, message: { attempts: number } }) => ({
        env: {},
        db: {},
        log: {},
        jobId: job.id,
        batchId: null,
        attempt: message.attempts,
        release: vi.fn(),
        fail: vi.fn(),
      }),
    }
    const first = createQueueBatch('cf-default', [buildJobPayload('demo/flaky-once', {})], { ids: ['same-id'] })
    await processRegisteredQueueBatch({ batch: first, env: {} }, opts as never)
    expect(calls).toBe(1)
    expect(first.messages[0]?.acked).toBe(false)
    expect(first.messages[0]?.retries).toEqual([{ delaySeconds: 1 }])

    const second = createQueueBatch('cf-default', [buildJobPayload('demo/flaky-once', {})], { ids: ['same-id'] })
    second.messages[0]!.attempts = 2
    await processRegisteredQueueBatch({ batch: second, env: {} }, opts as never)

    expect(calls).toBe(2)
    expect(second.messages[0]?.acked).toBe(true)
    expect(second.messages[0]?.retries).toEqual([])
  })

  it('acks registered queue ctx.fail() as an explicit failure, not a completed success', async () => {
    const failed = vi.fn()
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/fail-control',
        queue: 'default',
        async handle(_payload: Record<string, never>, ctx: { fail: (error: string) => Promise<void> }) {
          await ctx.fail('bad order')
        },
        failed,
      }),
    ])
    const batch = createQueueBatch('cf-default', [
      buildJobPayload('demo/fail-control', {}),
    ])
    const onDispatchError = vi.fn()

    await processRegisteredQueueBatch({
      batch,
      env: {},
    }, {
      registry,
      queues: { default: { binding: 'QUEUE_DEFAULT', queueName: 'cf-default' } },
      onDispatchError,
      createContext: ({ control, job, message }) => ({
        env: {},
        db: {},
        log: {},
        jobId: job.id,
        batchId: null,
        attempt: message.attempts,
        release: vi.fn(),
        async fail(error: string) {
          control.handled = true
          control.action = 'failed'
          control.error = error
        },
      }),
    })

    expect(onDispatchError).toHaveBeenCalledWith(expect.objectContaining({ taskName: 'demo/fail-control', error: expect.any(Error) }))
    expect(failed).toHaveBeenCalledOnce()
    expect(failed).toHaveBeenCalledWith({}, expect.objectContaining({ jobId: expect.any(String) }), expect.objectContaining({ message: 'bad order' }))
    expect(batch.messages[0]?.acked).toBe(true)
    expect(batch.messages[0]?.retries).toEqual([])
  })

  it('reports a lightweight failed-hook defect without replaying a terminal ctx.fail()', async () => {
    const hookError = new Error('failed hook exploded')
    const onDispatchError = vi.fn()
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/fail-hook-defect',
        queue: 'default',
        async handle(_payload, ctx) {
          await ctx.fail('terminal')
        },
        async failed() {
          throw hookError
        },
      }),
    ])
    const batch = createQueueBatch('cf-default', [buildJobPayload('demo/fail-hook-defect', {})])

    await processRegisteredQueueBatch({ batch, env: {} }, {
      registry,
      queues: { default: { binding: 'QUEUE_DEFAULT', queueName: 'cf-default' } },
      onDispatchError,
      createContext: ({ control, job, message }) => ({
        env: {},
        db: {},
        log: {},
        jobId: job.id,
        batchId: null,
        attempt: message.attempts,
        release: vi.fn(),
        async fail(error) {
          control.handled = true
          control.action = 'failed'
          control.error = error
        },
      }),
    })

    expect(onDispatchError).toHaveBeenCalledWith(expect.objectContaining({ error: hookError }))
    expect(batch.messages[0]?.acked).toBe(true)
    expect(batch.messages[0]?.retries).toEqual([])
  })

  it('reports a lightweight failed-hook defect to stderr when no observer exists', async () => {
    const hookError = new Error('failed hook exploded without observer')
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/fail-hook-stderr',
        queue: 'default',
        async handle(_payload, ctx) {
          await ctx.fail('terminal')
        },
        async failed() {
          throw hookError
        },
      }),
    ])
    const batch = createQueueBatch('cf-default', [buildJobPayload('demo/fail-hook-stderr', {})])

    await processRegisteredQueueBatch({ batch, env: {} }, {
      registry,
      queues: { default: { binding: 'QUEUE_DEFAULT', queueName: 'cf-default' } },
      createContext: ({ control, job, message }) => ({
        env: {},
        db: {},
        log: {},
        jobId: job.id,
        batchId: null,
        attempt: message.attempts,
        release: vi.fn(),
        async fail(error) {
          control.handled = true
          control.action = 'failed'
          control.error = error
        },
      }),
    })

    expect(stderr).toHaveBeenCalledWith(
      '[nuxt-cf-jobs] queue observer unavailable',
      expect.objectContaining({ error: hookError, taskName: 'demo/fail-hook-stderr' }),
    )
    expect(batch.messages[0]?.acked).toBe(true)
    expect(batch.messages[0]?.retries).toEqual([])
    stderr.mockRestore()
  })

  it('isolates a throwing queue observer from terminal message handling', async () => {
    const hookError = new Error('failed hook exploded')
    const observerError = new Error('observer exploded')
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onDispatchError = vi.fn().mockRejectedValue(observerError)
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/fail-hook-observer-defect',
        queue: 'default',
        async handle(_payload, ctx) {
          await ctx.fail('terminal')
        },
        async failed() {
          throw hookError
        },
      }),
    ])
    const batch = createQueueBatch('cf-default', [buildJobPayload('demo/fail-hook-observer-defect', {})])

    await processRegisteredQueueBatch({ batch, env: {} }, {
      registry,
      queues: { default: { binding: 'QUEUE_DEFAULT', queueName: 'cf-default' } },
      onDispatchError,
      createContext: ({ control, job, message }) => ({
        env: {},
        db: {},
        log: {},
        jobId: job.id,
        batchId: null,
        attempt: message.attempts,
        release: vi.fn(),
        async fail(error) {
          control.handled = true
          control.action = 'failed'
          control.error = error
        },
      }),
    })

    expect(onDispatchError).toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledWith(
      '[nuxt-cf-jobs] queue observer failed',
      expect.objectContaining({ error: hookError, observerError }),
    )
    expect(batch.messages[0]?.acked).toBe(true)
    expect(batch.messages[0]?.retries).toEqual([])
    stderr.mockRestore()
  })

  it('acks invalid registered queue payloads and reports validation failures', async () => {
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/validated-queue',
        queue: 'default',
        input: {
          safeParse(payload: unknown) {
            return payload && typeof payload === 'object' && typeof (payload as { id?: unknown }).id === 'string'
              ? { success: true as const, data: payload as { id: string } }
              : { success: false as const, error: new Error('id is required') }
          },
        },
        async handle() {},
      }),
    ])
    const batch = createQueueBatch('cf-default', [
      buildJobPayload('demo/validated-queue', { missing: true }),
    ])
    const onInvalidPayload = vi.fn()

    await processRegisteredQueueBatch({
      batch,
      env: {},
    }, {
      registry,
      queues: { default: { binding: 'QUEUE_DEFAULT', queueName: 'cf-default' } },
      onInvalidPayload,
      createContext: vi.fn(),
    })

    expect(onInvalidPayload).toHaveBeenCalledWith(expect.objectContaining({
      taskName: 'demo/validated-queue',
      error: 'Invalid payload for task: demo/validated-queue',
      validationError: expect.any(Error),
    }))
    expect(batch.messages[0]?.acked).toBe(true)
    expect(batch.messages[0]?.retries).toEqual([])
  })

  it('acks DLQ messages through the registered queue consumer hook', async () => {
    const batch = createQueueBatch('cf-default-dlq', [
      buildJobPayload('demo/dlq', { id: 'job_1' }),
    ])
    const onDlq = vi.fn()

    await processRegisteredQueueBatch({
      batch,
      env: {},
    }, {
      registry: defineJobRegistry([]),
      queues: {},
      onDlq,
      createContext: vi.fn(),
    })

    expect(onDlq).toHaveBeenCalledWith(expect.objectContaining({ batch, message: batch.messages[0] }))
    expect(batch.messages[0]?.acked).toBe(true)
  })

  it('registers the generic queue consumer on a Nitro hook', () => {
    const nitro = {
      hooks: {
        hook: vi.fn(),
      },
    }

    registerRegisteredQueueConsumer(nitro, {
      registry: defineJobRegistry([]),
      queues: {},
      createContext: vi.fn(),
    })

    expect(nitro.hooks.hook).toHaveBeenCalledWith('cloudflare:queue', expect.any(Function))
  })

  it('resolves logical queue names to configured Cloudflare bindings', () => {
    const queues = {
      default: 'QUEUE_DEFAULT',
      lighthouse: { binding: 'QUEUE_LH_SCANS', queueName: 'nuxtseo-lh-scans', jobType: 'perf' },
    }

    expect(resolveQueueBindingName(queues, 'lighthouse')).toBe('QUEUE_LH_SCANS')
    expect(resolveCloudflareQueueName(queues, 'lighthouse')).toBe('nuxtseo-lh-scans')
    expect(resolveLogicalQueueName(queues, 'nuxtseo-lh-scans')).toBe('lighthouse')
    expect(resolveQueueJobType(queues, 'lighthouse')).toBe('perf')
  })

  it('validates registered job queues against configured bindings', () => {
    const jobs = [
      defineJob({
        name: 'demo/default',
        queue: 'default',
        async handle() {},
      }),
      defineJob({
        name: 'demo/missing',
        queue: 'missing',
        async handle() {},
      }),
    ]

    expect(validateJobQueueBindings({ default: 'QUEUE_DEFAULT' }, jobs)).toEqual([
      { jobName: 'demo/missing', queue: 'missing', reason: 'missing-binding' },
    ])
    expect(() => assertJobQueueBindings({ default: 'QUEUE_DEFAULT' }, jobs))
      .toThrow('Missing Cloudflare queue bindings for jobs: demo/missing -> missing')
  })

  it('validates job registry definitions before dispatch wiring', () => {
    const jobs = [
      defineJob({
        name: 'demo/duplicate',
        queue: 'default',
        async handle() {},
      }),
      defineJob({
        name: 'demo/duplicate',
        queue: 'default',
        async handle() {},
      }),
      { name: '', queue: '', handle: null },
    ]

    expect(validateJobDefinitions(jobs)).toEqual([
      { name: 'demo/duplicate', reason: 'duplicate-name' },
      { name: '<unknown>', reason: 'invalid-definition' },
      { name: '<unknown>', reason: 'invalid-queue' },
    ])
    expect(() => assertJobDefinitions(jobs)).toThrow('Invalid nuxt-cf-jobs registry')
    expect(() => defineJobRegistry(jobs as never)).toThrow('demo/duplicate: duplicate-name')
  })

  it('publishes typed job messages from a job definition', async () => {
    const job = defineJob({
      name: 'demo/queue-publish',
      queue: 'lighthouse',
      input: {
        safeParse(payload: unknown) {
          return payload && typeof payload === 'object' && typeof (payload as { id?: unknown }).id === 'string'
            ? { success: true as const, data: payload as { id: string } }
            : { success: false as const, error: new Error('id is required') }
        },
      },
      async handle() {},
    })
    const fake = createFakeQueueEnv<{ _task: 'demo/queue-publish', id: string }>('QUEUE_LH_SCANS')
    const queue = createJobQueue(fake.env, {
      lighthouse: { binding: 'QUEUE_LH_SCANS', queueName: 'nuxtseo-lh-scans' },
    }, job)

    await expect(queue.send({ id: 'scan_1' }, { delaySeconds: 3 })).resolves.toBe(true)
    await expect(queue.send({} as { id: string })).rejects.toThrow('Invalid payload for task: demo/queue-publish')
    expect(fake.messages).toEqual([{ body: { _task: 'demo/queue-publish', id: 'scan_1' }, opts: { delaySeconds: 3 } }])
  })

  it('reports unavailable queue bindings through the publisher hook', async () => {
    const job = defineJob({
      name: 'demo/missing-binding',
      queue: 'default',
      async handle() {},
    })
    const onUnavailable = vi.fn()
    const queue = createJobQueue({}, { default: 'QUEUE_DEFAULT' }, job, { onUnavailable })

    await expect(queue.sendBatch([{ id: '1' }, { id: '2' }] as never)).resolves.toBe(false)

    expect(onUnavailable).toHaveBeenCalledWith({
      job,
      queue: 'default',
      binding: 'QUEUE_DEFAULT',
      reason: 'missing-env-binding',
      count: 2,
    })
  })

  it('uses typed batch publishing via createJobQueue', async () => {
    const job = defineJob({
      name: 'demo/queue-batch',
      queue: 'default',
      async handle() {},
    })
    const fake = createFakeQueueEnv<{ _task: 'demo/queue-batch', id: string }>('QUEUE_DEFAULT')
    const queue = createJobQueue(fake.env, { default: 'QUEUE_DEFAULT' }, job)

    await expect(queue.sendBatch([{ id: '1' }, { id: '2' }], { delaySeconds: 7 })).resolves.toBe(true)

    expect(fake.messages).toEqual([
      { body: { _task: 'demo/queue-batch', id: '1' }, opts: { delaySeconds: 7 } },
      { body: { _task: 'demo/queue-batch', id: '2' }, opts: { delaySeconds: 7 } },
    ])
  })

  it('uses current Cloudflare batch options and splits batches by byte size', async () => {
    const sendBatch = vi.fn(async () => ({
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    }))
    const queue = {
      send: vi.fn(async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } })),
      sendBatch,
    }
    const messages = [1, 2, 3].map(id => ({ id, data: 'x'.repeat(86_000) }))

    await sendBatchChunked(queue, messages, { delaySeconds: 7, contentType: 'json' })

    expect(sendBatch).toHaveBeenCalledTimes(2)
    expect(sendBatch.mock.calls[0]?.[1]).toEqual({ delaySeconds: 7 })
    expect(sendBatch.mock.calls[0]?.[0]).toEqual(messages.slice(0, 2).map(body => ({ body, contentType: 'json' })))
    expect(sendBatch.mock.calls[1]?.[0]).toEqual([{ body: messages[2], contentType: 'json' }])
  })

  it('keeps the Cloudflare Queue 128KB limit for direct messages', async () => {
    const queue = {
      send: vi.fn(async () => undefined),
      sendBatch: vi.fn(async () => undefined),
    }

    await expect(sendBatchChunked(queue, [{ huge: 'x'.repeat(130_000) }]))
      .rejects
      .toThrow(/maximum is 128000 bytes/)

    expect(queue.send).not.toHaveBeenCalled()
    expect(queue.sendBatch).not.toHaveBeenCalled()
  })

  it('exposes exponential backoff for retry policy', () => {
    expect(exponentialBackoff(0)).toBe(30)
    expect(exponentialBackoff(4, { baseSeconds: 10, maxSeconds: 60 })).toBe(60)
  })

  it('supports Laravel-style job policy aliases', () => {
    expect(resolveJobMaxAttempts({ tries: 3, maxAttempts: 5 })).toBe(3)
    expect(resolveJobMaxAttempts({ maxAttempts: 5 })).toBe(5)
    expect(resolveJobBackoff(30, 2)).toBe(30)
    expect(resolveJobBackoff([10, 30, 90], 2)).toBe(30)
    expect(resolveJobBackoff([10, 30, 90], 10)).toBe(90)
    expect(resolveJobBackoff(attempt => attempt * 5, 4)).toBe(20)
    expect(resolveJobRetryDelay({ backoff: [5, 15] }, 2)).toBe(15)
    expect(resolveJobRetryDelay(undefined, 3, { baseSeconds: 10 })).toBe(40)
    expect(createJobTraceId()).toMatch(/^job_/)
  })

  it('creates stable unique keys independent of payload key order', async () => {
    await expect(
      createJobUniqueKey('demo/unique', { b: 2, a: 1 }),
    ).resolves.toBe(await createJobUniqueKey('demo/unique', { a: 1, b: 2 }))
  })

  it('prepares durable outbox records from job definitions', async () => {
    const record = await prepareDurableJob({
      id: 'job_1',
      name: 'demo/outbox',
      payload: { b: 2, a: 1 },
      route: { queue: 'default', jobType: 'sync' },
      definition: {
        tries: 5,
        unique: true,
        uniqueId: payload => `a:${payload.a}`,
      },
      siteId: 'site_1',
      userId: 10,
      now: 100,
      delaySeconds: 30,
      traceId: 'trace_1',
    })

    expect(record).toMatchObject({
      id: 'job_1',
      queue: 'default',
      jobType: 'sync',
      siteId: 'site_1',
      userId: 10,
      traceId: 'trace_1',
      attempts: 0,
      maxAttempts: 5,
      availableAt: 130,
      createdAt: 100,
    })
    expect(record.uniqueKey).toMatch(/^job_unique_/)
    expect(JSON.parse(record.payload)).toEqual({ _task: 'demo/outbox', b: 2, a: 1 })
  })

  it('prepares durable outbox records from a typed registry route', async () => {
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/registered',
        queue: 'critical',
        jobType: 'demo',
        tries: 7,
        unique: true,
        input: {
          safeParse(payload: unknown) {
            return payload && typeof payload === 'object' && typeof (payload as { id?: unknown }).id === 'string'
              ? { success: true as const, data: payload as { id: string } }
              : { success: false as const, error: new Error('id is required') }
          },
        },
        async handle() {},
      }),
    ])

    const record = await prepareRegisteredDurableJob(registry, {
      id: 'job_1',
      name: 'demo/registered',
      payload: { id: 'abc' },
      now: 100,
    })

    expect(record).toMatchObject({
      id: 'job_1',
      queue: 'critical',
      jobType: 'demo',
      maxAttempts: 7,
      availableAt: 100,
    })
    expect(JSON.parse(record.payload)).toEqual({ _task: 'demo/registered', id: 'abc' })
    await expect(prepareRegisteredDurableJob(registry, {
      name: 'demo/registered',
      payload: { id: 123 } as never,
    })).rejects.toThrow('Invalid payload for task: demo/registered')
  })

  it('stores serializable job continuations without passing them to handlers', async () => {
    const seen: unknown[] = []
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/continuations',
        queue: 'default',
        async handle(payload: { message: string }) {
          seen.push(payload)
        },
      }),
    ])
    const record = await prepareDurableJob({
      id: 'job_1',
      name: 'demo/continuations',
      payload: { message: 'hello' },
      route: { queue: 'default', jobType: 'sync' },
      now: 100,
      continuations: {
        then: [{ name: 'demo/after', payload: { source: 'job_1' } }],
        catch: [{ name: 'demo/catch', payload: { source: 'job_1' }, delaySeconds: 30 }],
      },
    })
    const payload = JSON.parse(record.payload)

    expect(getDurableJobContinuationsForStage(payload, 'then')).toEqual([
      { name: 'demo/after', payload: { source: 'job_1' } },
    ])
    expect(getDurableJobContinuationsForStage(payload, 'catch')).toEqual([
      { name: 'demo/catch', payload: { source: 'job_1' }, delaySeconds: 30 },
    ])

    await dispatchRegisteredJob({
      registry,
      job: {
        id: record.id,
        queue: record.queue,
        attempts: 1,
        batchId: null,
        payload,
      },
      createContext: () => ({
        env: {},
        db: {},
        log: {},
        jobId: record.id,
        batchId: null,
        attempt: 1,
        release: vi.fn(),
        fail: vi.fn(),
      }),
    })

    expect(seen).toEqual([{ message: 'hello' }])
  })

  it('serializes, parses, and dispatches named continuations', async () => {
    const continuation = { name: 'demo/after', payload: { jobId: 'job_1' }, delaySeconds: 5 }
    const serialized = serializeDurableJobContinuation(continuation)

    expect(parseDurableJobContinuation(serialized)).toEqual(continuation)

    const dispatched: unknown[] = []
    await dispatchDurableJobContinuations([continuation], async item => dispatched.push(item))

    expect(dispatched).toEqual([continuation])
  })

  it('groups durable outbox records into Cloudflare queue messages', () => {
    const grouped = groupQueueJobMessagesByQueue([
      { id: 'job_1', queue: 'default' },
      { id: 'job_2', queue: 'default' },
      { id: 'job_3', queue: 'slow' },
    ])

    expect(grouped.get('default')).toEqual([
      { jobId: 'job_1', queue: 'default' },
      { jobId: 'job_2', queue: 'default' },
    ])
    expect(grouped.get('slow')).toEqual([{ jobId: 'job_3', queue: 'slow' }])
  })

  it('provides queue publisher and durable enqueue seams', async () => {
    const fake = createFakeQueueEnv<{ jobId: string, queue: 'default' }>('QUEUE_DEFAULT')
    const publisher = createQueuePublisher(fake.env, (queue: 'default') => queue === 'default' ? 'QUEUE_DEFAULT' : undefined)
    const inserted: unknown[] = []
    const record = await prepareDurableJob({
      id: 'job_1',
      name: 'demo/enqueue',
      payload: {},
      route: { queue: 'default', jobType: 'sync' },
      now: 100,
    })

    await expect(enqueueDurableJob({
      async insertJob(job) {
        inserted.push(job)
        return true
      },
    }, publisher, record)).resolves.toEqual({ status: 'enqueued' })

    expect(inserted).toEqual([record])
    expect(fake.messages).toEqual([{ body: { jobId: 'job_1', queue: 'default' }, opts: undefined }])
  })

  it('dispatches durable job batches through queue publisher seams', async () => {
    const fake = createFakeQueueEnv<{ jobId: string, queue: 'default' | 'slow' }>('QUEUE_DEFAULT')
    fake.env.QUEUE_SLOW = fake.queue
    const publisher = createQueuePublisher(fake.env, (queue: 'default' | 'slow') => queue === 'default' ? 'QUEUE_DEFAULT' : 'QUEUE_SLOW')

    await expect(dispatchDurableJobBatch(publisher, [
      { id: 'job_1', queue: 'default' },
      { id: 'job_2', queue: 'default' },
      { id: 'job_3', queue: 'slow' },
    ])).resolves.toEqual([
      { queue: 'default', status: 'sent' },
      { queue: 'slow', status: 'sent' },
    ])

    expect(fake.messages).toEqual([
      { body: { jobId: 'job_1', queue: 'default' }, opts: undefined },
      { body: { jobId: 'job_2', queue: 'default' }, opts: undefined },
      { body: { jobId: 'job_3', queue: 'slow' }, opts: undefined },
    ])
  })

  it('reports per-queue durable batch dispatch failures without aborting other queues', async () => {
    const error = new Error('queue unavailable')
    const publisher = {
      async sendBatch(queue: 'default' | 'slow') {
        if (queue === 'slow')
          throw error
        return true
      },
    }

    await expect(dispatchDurableJobBatch(publisher, [
      { id: 'job_1', queue: 'default' },
      { id: 'job_2', queue: 'slow' },
    ])).resolves.toEqual([
      { queue: 'default', status: 'sent' },
      { queue: 'slow', status: 'failed', cause: error },
    ])
  })

  it('provides durable lifecycle seams for claim, completion, failure, and release', async () => {
    const job = { id: 'job_1', queue: 'default', attempts: 1, maxAttempts: 3 }
    const lifecycle = {
      claimJob: vi.fn(async (id: string) => id === job.id ? job : null),
      resolveClaimMiss: vi.fn(async () => 'in-flight' as const),
      completeJob: vi.fn(async (_job: typeof job, result?: unknown) => ({ durationMs: result === 'ok' ? 25 : 0 })),
      failJob: vi.fn(async () => {}),
      releaseJob: vi.fn(async () => {}),
    }

    await expect(claimDurableJob(lifecycle, 'job_1')).resolves.toEqual({ status: 'claimed', job })
    await expect(claimDurableJob(lifecycle, 'job_2')).resolves.toEqual({ status: 'in-flight' })
    await expect(completeDurableJob(lifecycle, job, 'ok')).resolves.toEqual({ durationMs: 25 })
    await failDurableJob(lifecycle, job, 'failed', { permanent: true })
    await releaseDurableJob(lifecycle, job, { delaySeconds: 30, error: 'retry' })

    expect(lifecycle.resolveClaimMiss).toHaveBeenCalledWith('job_2')
    expect(lifecycle.completeJob).toHaveBeenCalledWith(job, 'ok')
    expect(lifecycle.failJob).toHaveBeenCalledWith(job, 'failed', { permanent: true })
    expect(lifecycle.releaseJob).toHaveBeenCalledWith(job, { delaySeconds: 30, error: 'retry' })
  })

  it('runs durable queue messages through the canonical lifecycle runner', async () => {
    const handled: string[] = []
    const storedJob = {
      id: 'job_1',
      queue: 'default',
      payload: buildJobPayload('demo/durable-runner', { message: 'stored' }),
      attempts: 2,
      batchId: null,
      siteId: 'site_1',
      userId: 1,
    }
    const message = createQueueMessage({ jobId: storedJob.id, queue: 'default' as const })
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/durable-runner',
        queue: 'default',
        async handle(payload: { message: string }) {
          handled.push(payload.message)
        },
      }),
    ])
    const lifecycle = {
      claimJob: vi.fn(async () => storedJob),
      resolveClaimMiss: vi.fn(async () => 'not-found' as const),
      completeJob: vi.fn(async () => {}),
      failJob: vi.fn(async () => {}),
      releaseJob: vi.fn(async () => {}),
    }

    await expect(runDurableJobMessage({
      message,
      lifecycle,
      registry,
      toDispatchableJob: job => job,
      createJobContext: ({ job, control }) => ({
        env: {},
        db: {},
        log: {},
        jobId: job.id,
        batchId: job.batchId,
        attempt: job.attempts,
        async release(delaySeconds: number) {
          control.handled = true
          control.action = 'released'
          control.delaySeconds = delaySeconds
        },
        async fail(error: string) {
          control.handled = true
          control.action = 'failed'
          control.error = error
        },
      }),
      completeResult: () => 'ok',
    })).resolves.toMatchObject({ status: 'completed', dispatch: { success: true } })

    expect(handled).toEqual(['stored'])
    expect(message.acked).toBe(true)
    expect(lifecycle.completeJob).toHaveBeenCalledWith(storedJob, 'ok')
    expect(lifecycle.failJob).not.toHaveBeenCalled()
    expect(lifecycle.releaseJob).not.toHaveBeenCalled()
  })

  it('runs terminal failure callbacks only after max attempts', async () => {
    const failed = vi.fn(async () => {})
    const terminal = vi.fn(async () => {})
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/terminal-only',
        queue: 'default',
        async handle() {
          throw new Error('boom')
        },
        failed,
      }),
    ])
    const lifecycle = {
      claimJob: vi.fn(),
      completeJob: vi.fn(async () => {}),
      failJob: vi.fn(async () => {}),
      releaseJob: vi.fn(async () => {}),
    }
    const run = async (attempts: number) => {
      const stored = {
        id: `job_${attempts}`,
        queue: 'default',
        payload: buildJobPayload('demo/terminal-only', {}),
        attempts,
        batchId: null,
      }
      lifecycle.claimJob.mockResolvedValueOnce(stored)
      const message = createQueueMessage({ jobId: stored.id, queue: 'default' as const })
      const result = await runDurableJobMessage({
        message,
        lifecycle,
        registry,
        toDispatchableJob: job => job,
        createJobContext: ({ job }) => ({ env: {}, db: {}, log: {}, jobId: job.id, batchId: null, attempt: job.attempts, release: vi.fn(), fail: vi.fn() }),
        maxAttemptsOf: () => 2,
        onTerminalFailure: terminal,
      })
      return { message, result }
    }

    const first = await run(1)
    expect(first.result.status).toBe('errored')
    expect(terminal).not.toHaveBeenCalled()
    expect(failed).not.toHaveBeenCalled()

    const second = await run(2)
    expect(second.result.status).toBe('exhausted')
    expect(terminal).toHaveBeenCalledOnce()
    expect(lifecycle.failJob).toHaveBeenCalledOnce()
    expect(failed).not.toHaveBeenCalled()
  })

  it('runs the terminal callback only after ctx.fail() is durably persisted', async () => {
    const order: string[] = []
    const stored = {
      id: 'job_manual_failure',
      queue: 'default',
      payload: buildJobPayload('demo/manual-failure', {}),
      attempts: 1,
      batchId: null,
    }
    const message = createQueueMessage({ jobId: stored.id, queue: 'default' as const })
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/manual-failure',
        queue: 'default',
        async handle(_payload, ctx) {
          await ctx.fail('permanent input')
        },
      }),
    ])
    const lifecycle = {
      claimJob: vi.fn(async () => stored),
      completeJob: vi.fn(async () => {}),
      failJob: vi.fn(async () => { order.push('persisted') }),
      releaseJob: vi.fn(async () => {}),
    }

    const result = await runDurableJobMessage({
      message,
      lifecycle,
      registry,
      toDispatchableJob: job => job,
      createJobContext: ({ job, control }) => ({
        env: {},
        db: {},
        log: {},
        jobId: job.id,
        batchId: null,
        attempt: job.attempts,
        release: vi.fn(),
        async fail(error) {
          control.handled = true
          control.action = 'failed'
          control.error = error
        },
      }),
      onTerminalFailure: async () => { order.push('callback') },
    })

    expect(result.status).toBe('failed')
    expect(order).toEqual(['persisted', 'callback'])
    expect(message.acked).toBe(true)
  })

  it('does not run the ctx.fail() terminal callback when persistence fails', async () => {
    const persisted = new Error('D1 unavailable')
    const terminal = vi.fn()
    const stored = {
      id: 'job_manual_failure_persist_error',
      queue: 'default',
      payload: buildJobPayload('demo/manual-failure-persist-error', {}),
      attempts: 1,
      batchId: null,
    }
    const message = createQueueMessage({ jobId: stored.id, queue: 'default' as const })
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/manual-failure-persist-error',
        queue: 'default',
        async handle(_payload, ctx) {
          await ctx.fail('permanent input')
        },
      }),
    ])

    const result = await runDurableJobMessage({
      message,
      lifecycle: {
        claimJob: vi.fn(async () => stored),
        completeJob: vi.fn(async () => {}),
        failJob: vi.fn(async () => { throw persisted }),
        releaseJob: vi.fn(async () => {}),
      },
      registry,
      toDispatchableJob: job => job,
      createJobContext: ({ job, control }) => ({
        env: {},
        db: {},
        log: {},
        jobId: job.id,
        batchId: null,
        attempt: job.attempts,
        release: vi.fn(),
        async fail(error) {
          control.handled = true
          control.action = 'failed'
          control.error = error
        },
      }),
      onTerminalFailure: terminal,
    })

    expect(result.status).toBe('errored')
    expect(terminal).not.toHaveBeenCalled()
    expect(message.acked).toBe(false)
    expect(message.retries).toHaveLength(1)
  })

  it('provides durable recovery seams for dispatchable and stale reserved jobs', async () => {
    const dispatchable = [
      { id: 'job_1', queue: 'default' },
      { id: 'job_2', queue: 'default' },
    ]
    const repository = {
      findDispatchableJobs: vi.fn(async () => dispatchable),
      releaseStaleReservedJobs: vi.fn(async () => 2),
    }

    await expect(
      findDispatchableDurableJobs(repository, { now: 100, createdBefore: 40, limit: 10 }),
    ).resolves.toEqual(dispatchable)
    await expect(releaseStaleReservedDurableJobs(repository, {
      staleBefore: 50,
      availableAt: 100,
      error: 'stale reservation',
      limit: 10,
    })).resolves.toBe(2)

    expect(repository.findDispatchableJobs).toHaveBeenCalledWith({ now: 100, createdBefore: 40, limit: 10 })
    expect(repository.releaseStaleReservedJobs).toHaveBeenCalledWith({
      staleBefore: 50,
      availableAt: 100,
      error: 'stale reservation',
      limit: 10,
    })
  })

  it('provides a D1 durable job repository adapter', async () => {
    const db = createFakeD1()
    const repository = createD1DurableJobRepository(db)
    const record = await prepareDurableJob({
      id: 'job_1',
      name: 'demo/d1-adapter',
      payload: { message: 'database' },
      route: { queue: 'default', jobType: 'demo' },
      siteId: 'site_1',
      userId: 10,
      now: 100,
      traceId: 'trace_1',
    })

    await repository.migrate()
    await expect(repository.insertJob(record)).resolves.toBe(true)

    db.nextFirst = {
      id: 'job_1',
      queue: 'default',
      job_type: 'demo',
      batch_id: null,
      user_id: 10,
      site_id: 'site_1',
      partner_id: null,
      trace_id: 'trace_1',
      unique_key: null,
      payload: record.payload,
      attempts: 1,
      max_attempts: 3,
      reserved_at: 120,
      available_at: 100,
      created_at: 100,
      completed_at: null,
      failed_at: null,
      last_error: null,
    }

    const claimed = await repository.claimJob('job_1')
    expect(claimed?.id).toBe('job_1')
    expect(repository.toDispatchableJob(claimed!)).toEqual({
      id: 'job_1',
      queue: 'default',
      payload: { _task: 'demo/d1-adapter', message: 'database' },
      attempts: 1,
      batchId: null,
      siteId: 'site_1',
      userId: 10,
    })

    await repository.completeJob(claimed!, { durationMs: 25 })
    await repository.releaseJob(claimed!, { availableAt: 200, error: 'retry' })
    await repository.failJob(claimed!, 'failed')
    await repository.findDispatchableJobs({ now: 300, createdBefore: 200, limit: 5 })

    expect(db.execStatements).toHaveLength(1)
    expect(db.execStatements[0]).toBe(d1DurableJobMigrationSql.join(';\n'))
    expect(db.queries.some(query => query.includes('INSERT OR IGNORE INTO jobs'))).toBe(true)
    expect(db.queries.some(query => query.includes('UPDATE jobs') && query.includes('RETURNING *'))).toBe(true)
    expect(db.queries.some(query => query.includes('INSERT OR REPLACE INTO failed_jobs'))).toBe(true)
    expect(db.queries.some(query => query.includes('created_at <= ?'))).toBe(true)
    // now, createdBefore x2, staleReleasedBefore x2, redispatchedBefore x2, limit.
    // The redispatch pair is what stops the sweep re-sending the same rows every tick.
    expect(db.bindings).toContainEqual([300, 200, 200, null, null, null, null, 5])
  })

  it('exports Drizzle schema for persisted job stores', () => {
    expect(getTableName(cfJobs)).toBe('jobs')
    expect(getTableName(cfJobBatches)).toBe('job_batches')
    expect(getTableName(cfFailedJobs)).toBe('failed_jobs')
  })

  // Drift guard: the Drizzle schema (schema.ts) is the single source of truth for the
  // durable-jobs tables; the raw migration SQL (d1.ts) must stay in sync with it. Adding a
  // column/index to the schema without updating the migration SQL (or vice versa) fails here.
  it('keeps d1DurableJobMigrationSql in sync with the Drizzle schema', () => {
    const createStatements = d1DurableJobMigrationSql.filter(sql => /CREATE TABLE/i.test(sql))
    const indexStatements = d1DurableJobMigrationSql.filter(sql => /CREATE (?:UNIQUE )?INDEX/i.test(sql))

    const schemaIndexNames = new Set<string>()
    for (const table of [cfJobBatches, cfJobs, cfFailedJobs]) {
      const config = getTableConfig(table)
      const createSql = createStatements.find(sql => new RegExp(`CREATE TABLE IF NOT EXISTS ${config.name}\\b`).test(sql))
      expect(createSql, `missing CREATE TABLE for "${config.name}"`).toBeTruthy()

      // every Drizzle column must appear in the table's CREATE statement
      for (const column of config.columns)
        expect(createSql, `column "${config.name}.${column.name}" missing from migration SQL`).toContain(column.name)

      for (const idx of config.indexes) {
        const name = idx.config.name
        schemaIndexNames.add(name)
        expect(
          indexStatements.some(sql => sql.includes(name)),
          `index "${name}" defined in schema.ts but missing from migration SQL`,
        ).toBe(true)
      }
    }

    // no migration index without a matching Drizzle index (reverse drift)
    expect(indexStatements).toHaveLength(schemaIndexNames.size)
  })

  // Drift guard for the hand-written INSERT statements in d1.ts: a column added to the
  // list without a matching placeholder/bind arg (or vice versa) is a silent SQL bug. The
  // column names are also checked against the Drizzle schema so a typo can't slip through.
  it('keeps d1 INSERT column lists in sync with placeholders, binds, and the schema', async () => {
    // depth-aware split on top-level commas (so `unixepoch()` stays one token)
    const splitTopLevel = (inner: string) => {
      const out: string[] = []
      let depth = 0
      let current = ''
      for (const ch of inner) {
        if (ch === '(')
          depth++
        else if (ch === ')')
          depth--
        if (ch === ',' && depth === 0) {
          out.push(current.trim())
          current = ''
        }
        else {
          current += ch
        }
      }
      if (current.trim())
        out.push(current.trim())
      return out
    }
    // inner content of the first balanced (...) group at/after `from`
    const parenGroup = (sql: string, from: number) => {
      const start = sql.indexOf('(', from)
      let depth = 0
      for (let i = start; i < sql.length; i++) {
        if (sql[i] === '(')
          depth++
        else if (sql[i] === ')' && --depth === 0)
          return sql.slice(start + 1, i)
      }
      throw new Error('unbalanced parens')
    }

    const db = createFakeD1()
    const repository = createD1DurableJobRepository(db)
    const record = await prepareDurableJob({ name: 'x', payload: { a: 1 }, route: { queue: 'q', jobType: 't' } })
    await repository.insertJob(record)
    await repository.recordFailure({ queue: 'q', jobType: 't', payload: '{}', exception: 'boom', attempts: 1 })

    const schemaColumns = {
      jobs: new Set(getTableConfig(cfJobs).columns.map(c => c.name)),
      failed_jobs: new Set(getTableConfig(cfFailedJobs).columns.map(c => c.name)),
    }

    for (let i = 0; i < db.queries.length; i++) {
      const sql = db.queries[i]!
      const match = sql.match(/INSERT(?: OR \w+)? INTO (\w+)/)
      if (!match)
        continue
      const table = match[1] as keyof typeof schemaColumns
      if (!schemaColumns[table])
        continue

      const columns = splitTopLevel(parenGroup(sql, match.index! + match[0].length))
      const values = splitTopLevel(parenGroup(sql, sql.indexOf('VALUES')))
      const placeholders = values.filter(v => v === '?').length

      // every listed column exists in the Drizzle schema
      for (const column of columns)
        expect(schemaColumns[table].has(column), `INSERT into "${table}" references unknown column "${column}"`).toBe(true)
      // one value expression per column
      expect(values, `INSERT into "${table}": ${columns.length} columns but ${values.length} values`).toHaveLength(columns.length)
      // exactly one bind arg per `?` placeholder
      expect(db.bindings[i], `INSERT into "${table}": ${placeholders} placeholders but ${db.bindings[i]?.length} bind args`).toHaveLength(placeholders)
    }
  })

  it('reports queue send failures from enqueueDurableJob without losing the row', async () => {
    const inserted: unknown[] = []
    const error = new Error('payload too large')
    const publisher = {
      async send() {
        throw error
      },
    }
    const record = await prepareDurableJob({
      id: 'job_1',
      name: 'demo/enqueue-fail',
      payload: {},
      route: { queue: 'default', jobType: 'sync' },
      now: 100,
    })

    await expect(enqueueDurableJob({
      async insertJob(job) {
        inserted.push(job)
        return true
      },
    }, publisher, record)).resolves.toEqual({ status: 'dispatch-failed', cause: error })

    expect(inserted).toEqual([record])
  })

  it('chunks createJobQueue sendBatch to the Cloudflare 100-message limit', async () => {
    const fake = createFakeQueueEnv<{ _task: 'demo/chunked', i: number }>('QUEUE_DEFAULT')
    const batches: number[] = []
    fake.queue.sendBatch = async (batch) => {
      batches.push(batch.length)
    }
    const job = defineJob({
      name: 'demo/chunked',
      queue: 'default',
      async handle() {},
    })
    const publisher = createJobQueue(fake.env, { default: 'QUEUE_DEFAULT' }, job)
    const payloads = Array.from({ length: 250 }, (_, i) => ({ i }))

    await expect(publisher.sendBatch(payloads as never)).resolves.toBe(true)
    expect(batches).toEqual([100, 100, 50])
  })

  it('produces stable unique keys when payloads contain BigInt or Date values', async () => {
    const date = new Date('2024-01-02T03:04:05Z')
    await expect(
      createJobUniqueKey('demo/unique-bigint', { id: 10n, when: date }),
    ).resolves.toBe(await createJobUniqueKey('demo/unique-bigint', { id: 10n, when: date }))
  })

  it('clamps configured backoff delay to the Cloudflare 86400s ceiling', () => {
    expect(resolveJobBackoff(99_999, 1)).toBe(86400)
    expect(resolveJobRetryDelay({ backoff: () => 99_999 }, 1)).toBe(86400)
  })

  it('preserves the original handler error when failed hook itself throws', async () => {
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/failed-throws',
        queue: 'default',
        async handle() {
          throw new Error('original')
        },
        async failed() {
          throw new Error('hook exploded')
        },
      }),
    ])

    await expect(dispatchRegisteredJob({
      registry,
      job: { id: 'job_1', queue: 'default', attempts: 1, batchId: null, payload: buildJobPayload('demo/failed-throws', {}) },
      createContext: () => ({
        env: {},
        db: {},
        log: {},
        jobId: 'job_1',
        batchId: null,
        attempt: 1,
        release: vi.fn(),
        fail: vi.fn(),
      }),
    })).rejects.toThrow('original')
  })

  it('sweeps undispatched outbox rows back through the publisher', async () => {
    const dispatchable = [
      { id: 'job_1', queue: 'default' as const },
      { id: 'job_2', queue: 'default' as const },
    ]
    const sent: Array<{ queue: string, messages: unknown[] }> = []
    const repository = {
      async findDispatchableJobs() {
        return dispatchable
      },
    }
    const publisher = {
      async sendBatch(queue: string, messages: unknown[]) {
        sent.push({ queue, messages })
        return true
      },
    }
    const { sweepDispatchableDurableJobs } = await import('#cf-jobs/server')

    await expect(sweepDispatchableDurableJobs(repository, publisher)).resolves.toEqual({
      swept: 2,
      dispatched: [{ queue: 'default', status: 'sent' }],
    })
    expect(sent).toEqual([{ queue: 'default', messages: [
      { jobId: 'job_1', queue: 'default' },
      { jobId: 'job_2', queue: 'default' },
    ] }])
  })

  it('uses the shouldSendToDlq helper to decide when attempts exhausted', async () => {
    const { shouldSendToDlq, createDlqPublisher } = await import('../src/runtime/server/queue')
    expect(shouldSendToDlq({ attempts: 3, maxAttempts: 3 })).toBe(true)
    expect(shouldSendToDlq({ attempts: 2, maxAttempts: 3 })).toBe(false)
    expect(shouldSendToDlq({ attempts: 2 })).toBe(false)

    const fake = createFakeQueue<{ id: string }>()
    const dlq = createDlqPublisher({ DLQ: fake.queue }, 'DLQ')
    await expect(dlq.send({ id: 'job_1' })).resolves.toBe(true)
    expect(fake.messages).toEqual([{ body: { id: 'job_1' }, opts: undefined }])
  })

  it('retries an unknown logical queue rather than silently dropping messages', async () => {
    const batch = createQueueBatch('cf-unknown', [
      buildJobPayload('demo/anything', { id: 1 }),
    ])
    const onMissingQueue = vi.fn()

    await processRegisteredQueueBatch({
      batch,
      env: {},
    }, {
      registry: defineJobRegistry([]),
      queues: { default: { binding: 'QUEUE_DEFAULT', queueName: 'cf-default' } },
      onMissingQueue,
      createContext: vi.fn(),
      unknownQueueRetryDelaySeconds: 30,
    })

    expect(onMissingQueue).toHaveBeenCalledOnce()
    expect(batch.messages[0]?.acked).toBe(false)
    expect(batch.retriedAll).toEqual([{ delaySeconds: 30 }])
  })

  it('forwards exhausted messages to the configured DLQ binding on dispatch failure', async () => {
    const fake = createFakeQueue<Record<string, unknown>>()
    const failed = vi.fn()
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/explodes',
        queue: 'default',
        tries: 2,
        async handle() {
          throw new Error('boom')
        },
        failed,
      }),
    ])
    const batch = createQueueBatch('cf-default', [
      buildJobPayload('demo/explodes', { id: 'x' }),
    ])
    batch.messages[0]!.attempts = 2
    const onDlq = vi.fn()

    await processRegisteredQueueBatch({
      batch,
      env: { DLQ: fake.queue },
    }, {
      registry,
      queues: {
        default: {
          binding: 'QUEUE_DEFAULT',
          queueName: 'cf-default',
          deadLetterQueue: 'cf-default-dlq',
          deadLetterQueueBinding: 'DLQ',
        },
      },
      onDlq,
      createContext: ({ job, message }) => ({
        env: {},
        db: {},
        log: {},
        jobId: job.id,
        batchId: null,
        attempt: message.attempts,
        release: vi.fn(),
        fail: vi.fn(),
      }),
    })

    expect(onDlq).toHaveBeenCalledOnce()
    expect(failed).toHaveBeenCalledOnce()
    expect(failed).toHaveBeenCalledWith({ id: 'x' }, expect.objectContaining({ jobId: expect.any(String) }), expect.objectContaining({ message: 'boom' }))
    expect(fake.messages).toHaveLength(1)
    expect(batch.messages[0]?.acked).toBe(true)
    expect(batch.messages[0]?.retries).toEqual([])
  })

  it('dedupes duplicate at-least-once deliveries by message id', async () => {
    const handled: number[] = []
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/idempotent',
        queue: 'default',
        async handle(payload: { n: number }) {
          handled.push(payload.n)
        },
      }),
    ])
    const opts = {
      registry,
      queues: { default: { binding: 'QUEUE_DEFAULT', queueName: 'cf-default' } },
      createContext: ({ job }: { job: { id: string } }) => ({
        env: {},
        db: {},
        log: {},
        jobId: job.id,
        batchId: null,
        attempt: 1,
        release: vi.fn(),
        fail: vi.fn(),
      }),
    }
    const first = createQueueBatch('cf-default', [buildJobPayload('demo/idempotent', { n: 1 })], { ids: ['msg-1'] })
    await processRegisteredQueueBatch({ batch: first, env: {} }, opts as never)
    const second = createQueueBatch('cf-default', [buildJobPayload('demo/idempotent', { n: 1 })], { ids: ['msg-1'] })
    await processRegisteredQueueBatch({ batch: second, env: {} }, opts as never)

    expect(handled).toEqual([1])
    expect(second.messages[0]?.acked).toBe(true)
  })

  it('validates wrangler consumer config against job definitions', async () => {
    const { validateQueueConsumerConfig } = await import('../src/runtime/server/queue')
    const jobs = [
      defineJob({
        name: 'demo/loud',
        queue: 'default',
        tries: 10,
        async handle() {},
      }),
    ]
    expect(validateQueueConsumerConfig({
      default: { binding: 'Q', queueName: 'cf-default', maxRetries: 3 },
    }, jobs)).toEqual([
      expect.objectContaining({ jobName: 'demo/loud', reason: 'tries-exceeds-max-retries' }),
    ])

    expect(validateQueueConsumerConfig({
      default: { binding: 'Q', queueName: 'cf-default', deadLetterQueue: 'no-binding' },
    }, jobs)).toEqual([
      expect.objectContaining({ reason: 'dlq-binding-missing' }),
    ])
  })

  it('retries transient 429 errors when sending to a queue', async () => {
    const { withSendBackpressure } = await import('../src/runtime/server/queue')
    let calls = 0
    const result = await withSendBackpressure(async () => {
      calls++
      if (calls < 3) {
        const err = new Error('too many requests') as Error & { status: number }
        err.status = 429
        throw err
      }
      return 'ok'
    }, { baseDelayMs: 1, maxDelayMs: 2 })
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })

  it('does not retry non-transient errors when sending', async () => {
    const { withSendBackpressure } = await import('../src/runtime/server/queue')
    let calls = 0
    await expect(withSendBackpressure(async () => {
      calls++
      throw new Error('payload too large')
    }, { baseDelayMs: 1 })).rejects.toThrow('payload too large')
    expect(calls).toBe(1)
  })

  it('throws from defineCfJobsQueues on duplicate bindings and half-configured DLQ', async () => {
    const { defineCfJobsQueues } = await import('#cf-jobs/server')
    expect(defineCfJobsQueues({
      default: 'QUEUE_DEFAULT',
      analytics: { binding: 'QUEUE_ANALYTICS', queueName: 'cf-analytics' },
    })).toBeDefined()

    expect(() => defineCfJobsQueues({
      a: 'SAME',
      b: { binding: 'SAME', queueName: 'b' },
    })).toThrow(/duplicate-binding/)

    expect(() => defineCfJobsQueues({
      default: { binding: 'Q', queueName: 'cf', deadLetterQueue: 'cf-dlq' },
    })).toThrow(/dlq-pair-incomplete/)
  })

  it('cross-checks wrangler config against module queue expectations', async () => {
    const { crossCheckWrangler } = await import('../src/wrangler')
    const wrangler = {
      path: 'wrangler.toml',
      producers: [{ binding: 'Q', queue: 'cf-q' }],
      consumers: [{ queue: 'cf-q', maxRetries: 2 }],
    }
    expect(crossCheckWrangler(wrangler, [
      { logical: 'default', binding: 'Q', cfQueueName: 'cf-q' },
    ])).toEqual([])

    expect(crossCheckWrangler(wrangler, [
      { logical: 'missing', binding: 'OTHER', cfQueueName: 'cf-other' },
    ])).toEqual([
      expect.objectContaining({ reason: 'missing-producer' }),
      expect.objectContaining({ reason: 'missing-consumer' }),
    ])

    expect(crossCheckWrangler(wrangler, [
      { logical: 'default', binding: 'Q', cfQueueName: 'cf-q', maxRetries: 5 },
    ])).toEqual([
      expect.objectContaining({ reason: 'max-retries-too-low' }),
    ])
  })

  it('parses [[queues.producers]] and [[queues.consumers]] blocks from a TOML string', async () => {
    const { parseWranglerConfig } = await import('../src/wrangler')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const tmp = path.join(os.tmpdir(), `wrangler-test-${Date.now()}.toml`)
    fs.writeFileSync(tmp, [
      '[[queues.producers]]',
      'binding = "Q1"',
      'queue = "queue-one"',
      '',
      '[[queues.consumers]]',
      'queue = "queue-one"',
      'max_retries = 3',
      'max_batch_size = 10',
    ].join('\n'))
    const parsed = parseWranglerConfig(tmp)
    fs.unlinkSync(tmp)
    expect(parsed.producers).toEqual([{ binding: 'Q1', queue: 'queue-one' }])
    expect(parsed.consumers[0]).toMatchObject({ queue: 'queue-one', maxRetries: 3, maxBatchSize: 10 })
  })

  it('propagates per-message delaySeconds through sendBatchMessages', async () => {
    const job = defineJob({
      name: 'demo/per-msg',
      queue: 'default',
      async handle() {},
    })
    const fake = createFakeQueueEnv<{ _task: 'demo/per-msg', i: number }>('QUEUE_DEFAULT')
    const queue = createJobQueue(fake.env, { default: 'QUEUE_DEFAULT' }, job)

    await expect(queue.sendBatchMessages([
      { payload: { i: 1 }, delaySeconds: 10 },
      { payload: { i: 2 }, delaySeconds: 20 },
    ])).resolves.toBe(true)

    expect(fake.messages).toEqual([
      { body: { _task: 'demo/per-msg', i: 1 }, opts: { delaySeconds: 10 } },
      { body: { _task: 'demo/per-msg', i: 2 }, opts: { delaySeconds: 20 } },
    ])
  })

  it('d1 repo insertJobs batches and reports per-chunk results', async () => {
    const db = createFakeD1()
    db.nextRun = { success: true, meta: { changes: 1 } }
    const repository = createD1DurableJobRepository(db)
    const records = await Promise.all([1, 2, 3].map(i => prepareDurableJob({
      id: `job_${i}`,
      name: 'demo/batch',
      payload: { i },
      route: { queue: 'default', jobType: 'demo' },
      now: 100,
      traceId: `trace_${i}`,
    })))

    const result = await repository.insertJobs(records, { batchSize: 2 })
    expect(result.chunks).toHaveLength(2)
    expect(result.chunks.every(c => c.ok)).toBe(true)
    expect(result.inserted).toHaveLength(3)
  })

  it('d1 repo insertJobs uses db.batch when available', async () => {
    const calls: number[] = []
    const db = createFakeD1() as ReturnType<typeof createFakeD1> & {
      batch: (stmts: unknown[]) => Promise<Array<{ success: boolean, meta: { changes: number } }>>
    }
    db.batch = async (stmts) => {
      calls.push(stmts.length)
      return stmts.map(() => ({ success: true, meta: { changes: 1 } }))
    }
    const repository = createD1DurableJobRepository(db)
    const records = await Promise.all([1, 2, 3, 4].map(i => prepareDurableJob({
      id: `b_${i}`,
      name: 'demo/batch',
      payload: { i },
      route: { queue: 'default', jobType: 'demo' },
      now: 100,
      traceId: `trace_${i}`,
    })))
    const result = await repository.insertJobs(records, { batchSize: 3 })
    expect(calls).toEqual([3, 1])
    expect(result.inserted).toHaveLength(4)
  })

  it('d1 repo awaits lifecycle hooks while isolating observer failures', async () => {
    const db = createFakeD1()
    const events: Array<{ type: string, id: string }> = []
    const observerErrors: string[] = []
    const repository = createD1DurableJobRepository(db, {
      async onObserverError({ stage }) {
        observerErrors.push(stage)
      },
      async onJobClaimed({ job }) {
        await Promise.resolve()
        events.push({ type: 'claimed', id: job.id })
        throw new Error('observer')
      },
      async onJobCompleted({ job }) {
        await Promise.resolve()
        events.push({ type: 'completed', id: job.id })
        throw new Error('observer')
      },
      async onJobFailed({ job }) {
        await Promise.resolve()
        events.push({ type: 'failed', id: job.id })
        throw new Error('observer')
      },
      async onJobReleased({ job }) {
        await Promise.resolve()
        events.push({ type: 'released', id: job.id })
        throw new Error('observer')
      },
    })
    db.nextFirst = {
      id: 'h_1',
      queue: 'default',
      job_type: 'demo',
      batch_id: null,
      user_id: null,
      site_id: null,
      partner_id: null,
      trace_id: null,
      unique_key: null,
      payload: '{}',
      attempts: 1,
      max_attempts: 3,
      reserved_at: 100,
      available_at: 100,
      created_at: 100,
      completed_at: null,
      failed_at: null,
      last_error: null,
    }
    const claimed = await repository.claimJob('h_1')
    await repository.completeJob(claimed!)
    await repository.releaseJob(claimed!)
    await repository.failJob(claimed!, 'oops')
    expect(events.map(e => e.type)).toEqual(['claimed', 'completed', 'released', 'failed'])
    expect(observerErrors).toEqual(['claimed', 'completed', 'released', 'failed'])
  })

  it('d1 repo recordFailure persists DLQ messages without touching jobs row', async () => {
    const db = createFakeD1()
    const repository = createD1DurableJobRepository(db)
    await repository.recordFailure({
      id: 'dlq_1',
      queue: 'default',
      jobType: 'demo',
      payload: '{"hello":"world"}',
      exception: '[DLQ default-dlq]',
      attempts: 5,
      maxAttempts: 3,
    })
    // Exactly one INSERT OR REPLACE INTO failed_jobs; no DELETE FROM jobs.
    const insertCalls = db.queries.filter(q => /INSERT OR REPLACE INTO failed_jobs/.test(q))
    const deleteCalls = db.queries.filter(q => /DELETE FROM jobs/.test(q))
    expect(insertCalls).toHaveLength(1)
    expect(deleteCalls).toHaveLength(0)
  })

  it('processRegisteredQueueBatch persists DLQ messages via dlqRepository when persist:true', async () => {
    const registry = defineJobRegistry([
      defineJob({
        name: 'demo/dlq',
        queue: 'sync',
        async handle() {},
      }),
    ])
    const failures: Array<{ exception: string, jobType: string, attempts: number }> = []
    const dlqRepository = {
      async recordFailure(input: { exception: string, jobType: string, attempts: number }) {
        failures.push({ exception: input.exception, jobType: input.jobType, attempts: input.attempts })
      },
    }
    const batch = createQueueBatch('sync-dlq', [
      { _task: 'demo/dlq', jobId: 'job_x', value: 1 },
    ])
    await processRegisteredQueueBatch({ env: {}, batch }, {
      registry,
      queues: { sync: 'QUEUE_SYNC' },
      createContext: () => ({ env: {}, db: {}, log: console, jobId: '', batchId: null, attempt: 0 }) as never,
      dlqQueues: { 'sync-dlq': { persist: true } },
      dlqRepository,
    })
    expect(failures).toHaveLength(1)
    expect(failures[0]?.jobType).toBe('demo/dlq')
    expect(batch.ackedAll).toBe(true)
  })

  it('does not acknowledge a DLQ batch when failure persistence fails', async () => {
    const error = new Error('failed_jobs unavailable')
    const onDispatchError = vi.fn()
    const batch = createQueueBatch('sync-dlq', [
      { _task: 'demo/dlq', jobId: 'job_x', value: 1 },
    ])

    const run = processRegisteredQueueBatch({ env: {}, batch }, {
      registry: defineJobRegistry([
        defineJob({ name: 'demo/dlq', queue: 'sync', async handle() {} }),
      ]),
      queues: { sync: 'QUEUE_SYNC' },
      createContext: () => ({}) as never,
      dlqQueues: { 'sync-dlq': { persist: true } },
      dlqRepository: { recordFailure: vi.fn().mockRejectedValue(error) },
      onDispatchError,
    })

    await expect(run).rejects.toBe(error)
    expect(onDispatchError).toHaveBeenCalledWith(expect.objectContaining({ error }))
    expect(batch.ackedAll).toBe(false)
  })

  it('rejects persist:true when no DLQ failure repository is configured', async () => {
    const batch = createQueueBatch('sync-dlq', [
      { _task: 'demo/dlq', jobId: 'job_x', value: 1 },
    ])

    await expect(processRegisteredQueueBatch({ env: {}, batch }, {
      registry: defineJobRegistry([]),
      queues: { sync: 'QUEUE_SYNC' },
      createContext: () => ({}) as never,
      dlqQueues: { 'sync-dlq': { persist: true } },
    })).rejects.toThrow('requires dlqRepository')
    expect(batch.ackedAll).toBe(false)
  })

  it('defineJob now allows omitting queue (default applied at registry build)', async () => {
    const job = defineJob({
      name: 'demo/no-queue',
      async handle() {},
    })
    expect(job.name).toBe('demo/no-queue')
    expect((job as { queue?: string }).queue).toBeUndefined()
  })
})

function createFakeD1() {
  const db = {
    execStatements: [] as string[],
    queries: [] as string[],
    bindings: [] as unknown[][],
    nextFirst: null as unknown,
    nextRun: { success: true, meta: { changes: 1 } },
    async exec(query: string) {
      this.execStatements.push(query)
    },
    prepare(query: string) {
      this.queries.push(query)
      return {
        bind(...values: unknown[]) {
          db.bindings.push(values)
          return this
        },
        async run() {
          return db.nextRun
        },
        async first<Result>() {
          const value = db.nextFirst
          db.nextFirst = null
          return value as Result | null
        },
        async all<Result>() {
          return { results: [] as Result[] }
        },
      }
    },
  }
  return db
}
