import { getTableName } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import {
  ackBatch,
  assertJobQueueBindings,
  buildJobPayload,
  cfFailedJobs,
  cfJobBatches,
  cfJobs,
  claimDurableJob,
  completeDurableJob,
  createFakeQueue,
  createFakeQueueEnv,
  createJobQueue,
  createJobTraceId,
  createJobUniqueKey,
  createQueueBatch,
  createQueuePublisher,
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
  parseDurableJobContinuation,
  prepareDurableJob,
  prepareRegisteredDurableJob,
  processRegisteredQueueBatch,
  registerQueueConsumer,
  registerRegisteredQueueConsumer,
  releaseDurableJob,
  releaseStaleReservedDurableJobs,
  resolveCloudflareQueueName,
  resolveJobBackoff,
  resolveJobMaxAttempts,
  resolveJobRetryDelay,
  resolveQueueBindingName,
  resolveQueueJobType,
  resolveLogicalQueueName,
  retryBatch,
  retryTransient,
  sendNamedQueueBatch,
  sendNamedQueueMessage,
  sendQueueBatch,
  sendQueueMessage,
  serializeDurableJobContinuation,
  validateJobQueueBindings,
} from '#cf-jobs/server'

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

  it('reports missing or unknown task names without calling a context factory', async () => {
    const registry = defineJobRegistry([])
    const createContext = vi.fn()

    await expect(dispatchRegisteredJob({
      registry,
      job: { id: 'job_1', queue: 'default', attempts: 1, batchId: null, payload: {} },
      createContext,
    })).resolves.toMatchObject({ success: false, handlerNotFound: true, error: 'No _task in payload' })

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
    })).resolves.toMatchObject({ success: false, handlerNotFound: true, error: 'No handler for task: missing/task' })

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
      invalidPayload: true,
      error: 'Invalid payload for task: demo/validated',
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

  it('runs a job-local failed hook for unhandled handler errors', async () => {
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

    expect(failed).toHaveBeenCalledOnce()
    expect(failed.mock.calls[0][0]).toEqual({ message: 'hello' })
    expect(failed.mock.calls[0][2]).toBeInstanceOf(Error)
  })

  it('provides fake queues and Cloudflare queue consumer helpers', async () => {
    const fake = createFakeQueue<{ id: string }>()
    await sendQueueMessage({ JOBS: fake.queue }, 'JOBS', { id: '1' }, { delaySeconds: 5 })
    expect(fake.messages).toEqual([{ body: { id: '1' }, opts: { delaySeconds: 5 } }])

    const handled: string[] = []
    let nitroHandler: any
    const nitro = {
      hooks: {
        hook: vi.fn((_name: string, handler: any) => {
          nitroHandler = handler
        }),
      },
    }
    registerQueueConsumer(nitro, 'default', async ({ batch }) => {
      handled.push(...batch.messages.map(m => m.body.id))
      for (const msg of batch.messages)
        msg.ack()
    })

    const batch = createQueueBatch('default', [{ id: 'a' }, { id: 'b' }])
    await nitroHandler({ batch, env: {} })

    expect(handled).toEqual(['a', 'b'])
    expect(batch.messages.every(m => m.acked)).toBe(true)
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

  it('resolves logical queue names to configured Cloudflare bindings', async () => {
    const queues = {
      default: 'QUEUE_DEFAULT',
      lighthouse: { binding: 'QUEUE_LH_SCANS', queueName: 'nuxtseo-lh-scans', jobType: 'perf' },
    }
    const fake = createFakeQueueEnv<{ id: string }>('QUEUE_LH_SCANS')

    const sent = sendNamedQueueMessage(fake.env, queues, 'lighthouse', { id: 'scan_1' })
    await expect(sent).resolves.toBe(true)
    expect(resolveQueueBindingName(queues, 'lighthouse')).toBe('QUEUE_LH_SCANS')
    expect(resolveCloudflareQueueName(queues, 'lighthouse')).toBe('nuxtseo-lh-scans')
    expect(resolveLogicalQueueName(queues, 'nuxtseo-lh-scans')).toBe('lighthouse')
    expect(resolveQueueJobType(queues, 'lighthouse')).toBe('perf')
    expect(fake.messages).toEqual([{ body: { id: 'scan_1' }, opts: undefined }])
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

  it('uses Cloudflare queue batch publishing when available', async () => {
    const fake = createFakeQueueEnv<{ id: string }>('QUEUE_DEFAULT')

    await expect(
      sendQueueBatch(fake.env, 'QUEUE_DEFAULT', [{ id: '1' }, { id: '2' }], { delaySeconds: 7 }),
    ).resolves.toBe(true)
    await expect(
      sendNamedQueueBatch(fake.env, { default: 'QUEUE_DEFAULT' }, 'default', [{ id: '3' }]),
    ).resolves.toBe(true)

    expect(fake.messages).toEqual([
      { body: { id: '1' }, opts: { delaySeconds: 7 } },
      { body: { id: '2' }, opts: { delaySeconds: 7 } },
      { body: { id: '3' }, opts: undefined },
    ])
  })

  it('provides retry policy helpers for direct queue consumers', () => {
    const [message] = createQueueBatch('default', [{ id: 'a' }]).messages

    expect(exponentialBackoff(0)).toBe(30)
    expect(exponentialBackoff(4, { baseSeconds: 10, maxSeconds: 60 })).toBe(60)
    expect(retryTransient(message!, { baseSeconds: 10 })).toEqual({ action: 'retry', delaySeconds: 10 })
    expect(message!.retries).toEqual([{ delaySeconds: 10 }])
  })

  it('uses Cloudflare batch ack and retry primitives when available', () => {
    const batch = createQueueBatch('default', [{ id: 'a' }, { id: 'b' }])

    expect(ackBatch(batch)).toEqual({ action: 'ack' })
    expect(batch.messages.every(message => message.acked)).toBe(true)

    expect(retryBatch(batch, { delaySeconds: 20 })).toEqual({ action: 'retry', delaySeconds: 20 })
    expect(batch.messages.map(message => message.retries)).toEqual([
      [{ delaySeconds: 20 }],
      [{ delaySeconds: 20 }],
    ])
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
    }, publisher, record)).resolves.toEqual({ inserted: true, dispatched: true })

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
      { queue: 'default', dispatched: true },
      { queue: 'slow', dispatched: true },
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
      { queue: 'default', dispatched: true },
      { queue: 'slow', dispatched: false, error },
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
      findDispatchableDurableJobs(repository, { now: 100, limit: 10 }),
    ).resolves.toEqual(dispatchable)
    await expect(releaseStaleReservedDurableJobs(repository, {
      staleBefore: 50,
      availableAt: 100,
      error: 'stale reservation',
      limit: 10,
    })).resolves.toBe(2)

    expect(repository.findDispatchableJobs).toHaveBeenCalledWith({ now: 100, limit: 10 })
    expect(repository.releaseStaleReservedJobs).toHaveBeenCalledWith({
      staleBefore: 50,
      availableAt: 100,
      error: 'stale reservation',
      limit: 10,
    })
  })

  it('exports Drizzle schema for persisted job stores', () => {
    expect(getTableName(cfJobs)).toBe('jobs')
    expect(getTableName(cfJobBatches)).toBe('job_batches')
    expect(getTableName(cfFailedJobs)).toBe('failed_jobs')
  })
})
