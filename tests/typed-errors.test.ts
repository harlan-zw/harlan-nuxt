import { describe, expect, it, vi } from 'vitest'
import {
  defineJob,
  defineJobRegistry,
  enqueueDurableJob,
  err,
  formatJobError,
  isErr,
  isJobError,
  isOk,
  jobErrors,
  jobErrorToException,
  mapErr,
  mapResult,
  matchResult,
  ok,
  prepareDurableJob,
  prepareDurableJobResult,
  runDurableJobMessage,
  unwrapResult,
  validateDurableJobContinuations,
} from '#cf-jobs/server'
import { createQueueMessage } from '#cf-jobs/testing'
import { buildJobPayload } from '../src/runtime/server/payload'

describe('result primitive (Either/Exit channel)', () => {
  it('discriminates ok and err', () => {
    const good = ok(42)
    const bad = err('nope')
    expect(isOk(good)).toBe(true)
    expect(isErr(bad)).toBe(true)
    expect(good).toEqual({ ok: true, value: 42 })
    expect(bad).toEqual({ ok: false, error: 'nope' })
  })

  it('maps only the matching channel', () => {
    expect(mapResult(ok(2), n => n * 2)).toEqual({ ok: true, value: 4 })
    expect(mapResult(err('e'), (n: number) => n * 2)).toEqual({ ok: false, error: 'e' })
    expect(mapErr(err('e'), e => `${e}!`)).toEqual({ ok: false, error: 'e!' })
    expect(mapErr(ok(2), (e: string) => `${e}!`)).toEqual({ ok: true, value: 2 })
  })

  it('folds both channels with matchResult', () => {
    const fold = (r: ReturnType<typeof ok<number>> | ReturnType<typeof err<string>>) =>
      matchResult(r, { onOk: v => `ok:${v}`, onErr: e => `err:${e}` })
    expect(fold(ok(1))).toBe('ok:1')
    expect(fold(err('x'))).toBe('err:x')
  })

  it('unwraps to a value or throws via the supplied mapper', () => {
    expect(unwrapResult(ok(7), () => new Error('unused'))).toBe(7)
    expect(() => unwrapResult(err('boom'), e => new Error(`wrapped:${e}`))).toThrow('wrapped:boom')
  })
})

describe('jobError tagged union (the E channel)', () => {
  it('builds discriminable, data-carrying errors', () => {
    expect(jobErrors.noTask()).toMatchObject({ _tag: 'no-task' })
    expect(jobErrors.handlerNotFound('a/b')).toMatchObject({ _tag: 'handler-not-found', task: 'a/b' })
    expect(jobErrors.payloadTooLarge('a/b', 200, 128)).toMatchObject({ _tag: 'payload-too-large', bytes: 200, limit: 128 })
    expect(jobErrors.continuationQueueMismatch('a/b', 'q1', 'q2')).toMatchObject({
      _tag: 'continuation-queue-mismatch',
      expected: 'q1',
      received: 'q2',
    })
  })

  it('preserves the underlying cause for invalid payloads', () => {
    const cause = new Error('id required')
    const error = jobErrors.invalidPayload('a/b', cause)
    expect(error.cause).toBe(cause)
    expect(formatJobError(error)).toBe('Invalid payload for task: a/b')
  })

  it('round-trips through an exception without losing the typed error', () => {
    const error = jobErrors.payloadTooLarge('a/b', 200, 128)
    const exception = jobErrorToException(error)
    expect(exception).toBeInstanceOf(Error)
    expect(exception.message).toBe(error.message)
    expect((exception as Error & { jobError?: unknown }).jobError).toBe(error)
    expect(isJobError((exception as Error & { jobError?: unknown }).jobError)).toBe(true)
  })

  it('isJobError rejects plain errors and objects', () => {
    expect(isJobError(new Error('x'))).toBe(false)
    expect(isJobError({ foo: 1 })).toBe(false)
    expect(isJobError(jobErrors.noTask())).toBe(true)
  })
})

describe('prepareDurableJobResult returns typed failures instead of throwing', () => {
  it('returns no-route when a task cannot be routed', async () => {
    const result = await prepareDurableJobResult({ name: 'orphan', payload: {} })
    expect(isErr(result)).toBe(true)
    expect(result).toMatchObject({ ok: false, error: { _tag: 'no-route', task: 'orphan' } })
  })

  it('returns payload-too-large with the offending byte count', async () => {
    const result = await prepareDurableJobResult({
      name: 'demo/huge',
      payload: { huge: 'x'.repeat(130 * 1024) },
      route: { queue: 'default', jobType: 'demo' },
    })
    expect(result).toMatchObject({ ok: false, error: { _tag: 'payload-too-large', task: 'demo/huge' } })
    if (isErr(result) && result.error._tag === 'payload-too-large')
      expect(result.error.bytes).toBeGreaterThan(result.error.limit)
  })

  it('returns ok with the record on success', async () => {
    const result = await prepareDurableJobResult({
      id: 'job_1',
      name: 'demo/ok',
      payload: { a: 1 },
      route: { queue: 'default', jobType: 'demo' },
      now: 100,
    })
    expect(isOk(result)).toBe(true)
    if (isOk(result))
      expect(result.value).toMatchObject({ id: 'job_1', queue: 'default', jobType: 'demo' })
  })

  it('throwing wrapper re-raises the same typed error as a cause', async () => {
    await expect(prepareDurableJob({ name: 'orphan', payload: {} }))
      .rejects
      .toMatchObject({ message: 'No route for task: orphan', jobError: { _tag: 'no-route' } })
  })
})

describe('validateDurableJobContinuations returns the first typed error', () => {
  const registry = defineJobRegistry([
    defineJob({ name: 'a/known', queue: 'q1', async handle() {} }),
  ])

  it('flags an unknown continuation task', () => {
    const error = validateDurableJobContinuations(registry, { then: [{ name: 'a/missing', payload: {} }] })
    expect(error).toMatchObject({ _tag: 'unknown-continuation', task: 'a/missing' })
  })

  it('flags a queue mismatch with expected/received', () => {
    const error = validateDurableJobContinuations(registry, { then: [{ name: 'a/known', payload: {}, queue: 'q2' }] })
    expect(error).toMatchObject({ _tag: 'continuation-queue-mismatch', expected: 'q1', received: 'q2' })
  })

  it('returns undefined when continuations are valid', () => {
    expect(validateDurableJobContinuations(registry, { then: [{ name: 'a/known', payload: {} }] })).toBeUndefined()
  })
})

describe('enqueueDurableJob discriminated outcome', () => {
  const record = {
    id: 'job_1',
    queue: 'default' as const,
    jobType: 'demo',
    traceId: 't',
    payload: '{}',
    attempts: 0,
    maxAttempts: 3,
    availableAt: 0,
    createdAt: 0,
  }

  it('reports enqueued on insert + send', async () => {
    const result = await enqueueDurableJob({ insertJob: async () => true }, { send: async () => true }, record)
    expect(result).toEqual({ status: 'enqueued' })
  })

  it('reports duplicate when the row already exists', async () => {
    const send = vi.fn()
    const result = await enqueueDurableJob({ insertJob: async () => false }, { send }, record)
    expect(result).toEqual({ status: 'duplicate' })
    expect(send).not.toHaveBeenCalled()
  })

  it('reports not-dispatched when the binding is missing (send returns false)', async () => {
    const result = await enqueueDurableJob({ insertJob: async () => true }, { send: async () => false }, record)
    expect(result).toEqual({ status: 'not-dispatched' })
  })

  it('reports dispatch-failed with the raw cause when the send throws', async () => {
    const cause = new Error('429 too many requests')
    const send = async () => {
      throw cause
    }
    const result = await enqueueDurableJob({ insertJob: async () => true }, { send }, record)
    expect(result).toEqual({ status: 'dispatch-failed', cause })
  })
})

describe('runDurableJobMessage discriminated outcome', () => {
  const registry = defineJobRegistry([
    defineJob({
      name: 'demo/run',
      queue: 'default',
      async handle(payload: { explode?: boolean }) {
        if (payload.explode)
          throw new Error('kaboom')
      },
    }),
  ])
  let storedJob: { id: string, queue: string, payload: Record<string, unknown>, attempts: number, batchId: null }
  const lifecycle = {
    claimJob: async () => storedJob,
    completeJob: vi.fn(async () => {}),
    failJob: vi.fn(async () => {}),
    releaseJob: vi.fn(async () => {}),
  }

  function context() {
    return {
      message: createQueueMessage({ jobId: 'job_1', queue: 'default' as const }),
      lifecycle,
      registry,
      toDispatchableJob: (job: typeof storedJob) => job,
      createJobContext: () => ({ env: {}, db: {}, log: {}, jobId: 'job_1', batchId: null, attempt: 1, release: vi.fn(), fail: vi.fn() }),
    }
  }

  it('returns errored carrying the defect as a handler-threw JobError, not released', async () => {
    storedJob = { id: 'job_1', queue: 'default', payload: buildJobPayload('demo/run', { explode: true }), attempts: 1, batchId: null }
    const result = await runDurableJobMessage(context())
    expect(result.status).toBe('errored')
    if (result.status === 'errored') {
      expect(result.error._tag).toBe('handler-threw')
      expect((result.error.cause as Error).message).toBe('kaboom')
    }
  })

  it('returns dispatch-failed with a typed error for an unknown task', async () => {
    storedJob = { id: 'job_1', queue: 'default', payload: buildJobPayload('demo/unknown', {}), attempts: 1, batchId: null }
    const result = await runDurableJobMessage(context())
    expect(result.status).toBe('dispatch-failed')
    if (result.status === 'dispatch-failed')
      expect(result.error?._tag).toBe('handler-not-found')
  })
})
