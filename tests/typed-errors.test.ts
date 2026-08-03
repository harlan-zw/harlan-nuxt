import { describe, expect, it, vi } from 'vitest'
import {
  defineJob,
  defineJobRegistry,
  describeCause,
  describeCauseWithStack,
  dispatchDurableJobBatch,
  DURABLE_JOB_MAX_PAYLOAD_BYTES,
  enqueueDurableJob,
  err,
  formatJobError,
  headlineOf,
  isErr,
  isJobError,
  isOk,
  jobErrors,
  jobErrorToException,
  mapErr,
  mapResult,
  matchResult,
  MAX_DESCRIBED_STACK_CHARS,
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

  it('accepts durable payloads larger than the Cloudflare Queue message limit', async () => {
    const result = await prepareDurableJobResult({
      name: 'demo/stored',
      payload: { stored: 'x'.repeat(150_000) },
      route: { queue: 'default', jobType: 'demo' },
    })
    expect(isOk(result)).toBe(true)
  })

  it('returns payload-too-large with the offending durable storage byte count', async () => {
    const result = await prepareDurableJobResult({
      name: 'demo/huge',
      payload: { huge: 'x'.repeat(DURABLE_JOB_MAX_PAYLOAD_BYTES) },
      route: { queue: 'default', jobType: 'demo' },
    })
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: 'payload-too-large',
        task: 'demo/huge',
        limit: DURABLE_JOB_MAX_PAYLOAD_BYTES,
      },
    })
    if (isErr(result) && result.error._tag === 'payload-too-large') {
      expect(result.error.bytes).toBeGreaterThan(result.error.limit)
    }
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

describe('dispatchDurableJobBatch discriminated per-queue outcome', () => {
  const records = [{ id: 'job_1', queue: 'default' as const }, { id: 'job_2', queue: 'slow' as const }]

  it('reports sent / not-dispatched / failed per queue', async () => {
    const cause = new Error('queue down')
    const publisher = {
      sendBatch: async (queue: 'default' | 'slow') => {
        if (queue === 'slow')
          throw cause
        return true
      },
    }
    const sent = await dispatchDurableJobBatch(publisher, records)
    expect(sent).toEqual([
      { queue: 'default', status: 'sent' },
      { queue: 'slow', status: 'failed', cause },
    ])
  })

  it('reports not-dispatched when the publisher returns false (binding missing)', async () => {
    const result = await dispatchDurableJobBatch({ sendBatch: async () => false }, [records[0]!])
    expect(result).toEqual([{ queue: 'default', status: 'not-dispatched' }])
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

describe('describeCauseWithStack (diagnostic rendering)', () => {
  it('keeps describeCause collapsing an Error to its message', () => {
    expect(describeCause(new Error('boom'))).toBe('boom')
    expect(describeCause('plain')).toBe('plain')
    expect(describeCause(42)).toBe('42')
  })

  it('renders the stack, not just the message', () => {
    const error = new Error('boom')
    const rendered = describeCauseWithStack(error)
    expect(rendered).toContain('boom')
    // A real stack names the frame; the bare message never did.
    expect(rendered).toContain('at ')
    expect(rendered).not.toBe('boom')
  })

  it('walks the cause chain', () => {
    const root = new TypeError('Cannot assign to read only property \'name\'')
    const wrapped = new Error('handler threw', { cause: root })
    const rendered = describeCauseWithStack(wrapped)
    expect(rendered).toContain('handler threw')
    expect(rendered).toContain('Caused by: ')
    expect(rendered).toContain('Cannot assign to read only property')
  })

  it('synthesises a rendering when stack is absent', () => {
    const error = new Error('no stack here')
    error.stack = undefined
    expect(describeCauseWithStack(error)).toBe('Error: no stack here')
  })

  it('falls back to describeCause for non-Errors', () => {
    expect(describeCauseWithStack('plain')).toBe('plain')
    expect(describeCauseWithStack(42)).toBe('42')
    expect(describeCauseWithStack(null)).toBe('null')
    expect(describeCauseWithStack(undefined)).toBe('undefined')
  })

  it('terminates on a cyclic cause chain', () => {
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    ;(a as Error & { cause?: unknown }).cause = b
    const rendered = describeCauseWithStack(b)
    expect(rendered).toContain('a')
    expect(rendered).toContain('b')
  })

  it('truncates a runaway stack so one defect cannot blow up a failed_jobs row', () => {
    const error = new Error('big')
    error.stack = 'x'.repeat(MAX_DESCRIBED_STACK_CHARS * 2)
    const rendered = describeCauseWithStack(error)
    expect(rendered.length).toBeLessThan(MAX_DESCRIBED_STACK_CHARS + 32)
    expect(rendered).toContain('… (truncated)')
  })
})

// Truncating the joined render from the front deleted exactly the part worth
// keeping. A `DrizzleQueryError` puts the whole failing SQL and its bind params
// in its own message/stack, so link 1 alone blew the budget and the real D1
// error underneath never reached `failed_jobs.exception` or the Sentry event
// (this is how a 100-bound-param rejection read as an opaque "Failed query: …"
// for two days).
describe('describeCauseWithStack keeps the deepest cause under truncation', () => {
  // ~5000 chars of SQL/params junk: a multi-row insert whose statement alone
  // exceeds MAX_DESCRIBED_STACK_CHARS, with the driver error only on `.cause`.
  function drizzleShapedError() {
    const sqlJunk = `insert into "job_batches" ("id", "name", "total_jobs", "pending_jobs") values ${'(?, ?, ?, ?), '.repeat(240)}`
    const params = Array.from({ length: 900 }, (_, i) => `"param-${i}"`).join(', ')
    const top = new Error(`Failed query: ${sqlJunk}\nparams: ${params}`, {
      cause: new Error('D1_ERROR: too many SQL variables at offset 132: SQLITE_ERROR'),
    })
    expect(top.message.length).toBeGreaterThan(5000)
    return top
  }

  // Slack for the truncation marker plus a capped-headline ellipsis — the budget
  // itself must not grow.
  const TRUNCATION_SLACK = 40

  it('includes the deepest cause when the top stack alone exceeds the budget', () => {
    expect(describeCauseWithStack(drizzleShapedError())).toContain('too many SQL variables')
  })

  it('stays within the documented budget plus marker slack', () => {
    expect(describeCauseWithStack(drizzleShapedError()).length).toBeLessThanOrEqual(MAX_DESCRIBED_STACK_CHARS + TRUNCATION_SLACK)
  })

  it('keeps line 1 as the top error headline, so headlineOf still signs the defect', () => {
    expect(headlineOf(describeCauseWithStack(drizzleShapedError())).startsWith('Error: Failed query:')).toBe(true)
  })

  it('renders an under-budget chain byte-identically to the untruncated shape', () => {
    const cause = new Error('D1_ERROR: no such table: gsc_pages')
    const top = new Error('Failed query: select 1', { cause })
    expect(describeCauseWithStack(top)).toBe(`${top.stack}\nCaused by: ${cause.stack}`)
  })

  it('caps a single runaway headline instead of crowding out the rest of the chain', () => {
    const deep = new Error('the actual root cause')
    const top = new Error('x'.repeat(MAX_DESCRIBED_STACK_CHARS * 2), { cause: deep })
    const rendered = describeCauseWithStack(top)
    expect(rendered).toContain('the actual root cause')
    expect(rendered.length).toBeLessThanOrEqual(MAX_DESCRIBED_STACK_CHARS + 40)
  })
})

describe('headlineOf', () => {
  it('returns a single-line message untouched', () => {
    expect(headlineOf('boom')).toBe('boom')
    expect(headlineOf('')).toBe('')
  })

  it('takes only the first line of a rendered stack', () => {
    const rendered = describeCauseWithStack(new TypeError('bad'))
    expect(headlineOf(rendered)).toBe('TypeError: bad')
    expect(headlineOf(rendered)).not.toContain('\n')
  })

  it('drops the cause chain', () => {
    const rendered = describeCauseWithStack(new Error('outer', { cause: new Error('inner') }))
    expect(headlineOf(rendered)).toBe('Error: outer')
    expect(headlineOf(rendered)).not.toContain('inner')
  })
})
