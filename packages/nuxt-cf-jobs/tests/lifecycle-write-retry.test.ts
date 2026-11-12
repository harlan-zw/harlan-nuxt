import type { RunDurableJobMessageOptions } from '#cf-jobs/server'
import { describe, expect, it, vi } from 'vitest'
import { defineJob, defineJobRegistry, DurableJobOwnershipError, isTransientD1WriteError, runDurableJobMessage } from '#cf-jobs/server'
import { createQueueMessage } from '#cf-jobs/testing'
import { buildJobPayload } from '../src/runtime/server/payload'

// Sentry NUXTSEO-PRO-13R: D1 shed load during `releaseJob`. The runtime threw
// out of the batch, so the whole batch failed and the row stayed reserved until
// the reconcile sweep. A completeJob or failJob throw was worse: it fell into
// the handler-failure path, so a finished job ran again or was failed.

interface StoredJob {
  id: string
  queue: string
  payload: Record<string, unknown>
  attempts: number
  batchId: null
}

const overloaded = () => new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.')

type Outcome = 'complete' | 'throw' | 'release' | 'fail'

function storedJob(outcome: Outcome): StoredJob {
  return { id: `job_${outcome}`, queue: 'default', payload: buildJobPayload(`demo/${outcome}`, {}), attempts: 1, batchId: null }
}

const handlers = {
  complete: vi.fn(async () => {}),
  throw: vi.fn(async () => { throw new Error('handler bug') }),
}

const registry = defineJobRegistry([
  defineJob({ name: 'demo/complete', queue: 'default', handle: handlers.complete }),
  defineJob({ name: 'demo/throw', queue: 'default', handle: handlers.throw }),
  defineJob({ name: 'demo/release', queue: 'default', async handle(_p, ctx) { await ctx.release(30) } }),
  defineJob({ name: 'demo/fail', queue: 'default', async handle(_p, ctx) { await ctx.fail('bad input') } }),
])

type Write = (...args: unknown[]) => Promise<void>

function writeThatThrows(errors: unknown[]): ReturnType<typeof vi.fn<Write>> {
  const queue = [...errors]
  return vi.fn<Write>(async () => {
    if (queue.length > 0)
      throw queue.shift()
  })
}

async function run(outcome: Outcome, writes: { completeJob?: Write, failJob?: Write, releaseJob?: Write }, extra: Partial<RunDurableJobMessageOptions<StoredJob, StoredJob>> = {}) {
  const stored = storedJob(outcome)
  const message = createQueueMessage({ jobId: stored.id, queue: 'default' as const }, 1)
  const lifecycle = {
    claimJob: vi.fn(async () => stored),
    completeJob: writes.completeJob ?? vi.fn<Write>(async () => {}),
    failJob: writes.failJob ?? vi.fn<Write>(async () => {}),
    releaseJob: writes.releaseJob ?? vi.fn<Write>(async () => {}),
  }
  const onTerminalFailure = vi.fn()
  const result = await runDurableJobMessage<StoredJob, StoredJob>({
    message,
    lifecycle: lifecycle as never,
    registry,
    toDispatchableJob: job => job,
    createJobContext: ({ job, control }) => ({
      env: {},
      db: {},
      log: {},
      jobId: job.id,
      batchId: null,
      attempt: job.attempts,
      async release(delaySeconds) {
        control.handled = true
        control.action = 'released'
        control.delaySeconds = delaySeconds
      },
      async fail(error) {
        control.handled = true
        control.action = 'failed'
        control.error = error
      },
    }),
    retryDelaySeconds: 5,
    maxAttemptsOf: () => 1,
    isPermanentFailure: () => false,
    onTerminalFailure,
    lifecycleWriteRetry: { backoffMs: () => 0, redeliveryDelaySeconds: 900 },
    ...extra,
  })
  return { result, message, lifecycle, onTerminalFailure }
}

describe('lifecycle write retry', () => {
  it('retries a transient release and then retries the message as usual', async () => {
    const releaseJob = writeThatThrows([overloaded()])
    const { result, message } = await run('throw', { releaseJob })

    expect(result.status).toBe('errored')
    expect(releaseJob).toHaveBeenCalledTimes(2)
    expect(message.retries).toEqual([{ delaySeconds: 5 }])
  })

  it.each([
    { outcome: 'throw', write: 'release' },
    { outcome: 'release', write: 'release' },
    { outcome: 'complete', write: 'complete' },
    { outcome: 'fail', write: 'fail' },
  ] as const)('defers a $write write that stays overloaded after a handler $outcome', async ({ outcome, write }) => {
    const cause = overloaded()
    const failing = writeThatThrows([cause, cause, cause, cause])
    const key = ({ complete: 'completeJob', fail: 'failJob', release: 'releaseJob' } as const)[write]
    const { result, message, lifecycle, onTerminalFailure } = await run(outcome, { [key]: failing })

    expect(result).toEqual({
      status: 'write-deferred',
      deferral: { write, tries: 3, delaySeconds: 900, cause },
    })
    expect(failing).toHaveBeenCalledTimes(3)
    // The redelivery reclaims the reservation once the window passes.
    expect(message.retries).toEqual([{ delaySeconds: 900 }])
    expect(message.acked).toBe(false)
    // A write failure is never a handler failure: nothing else settles the row.
    const others = (['completeJob', 'failJob', 'releaseJob'] as const).filter(k => k !== key)
    for (const other of others)
      expect(lifecycle[other]).not.toHaveBeenCalled()
    expect(onTerminalFailure).not.toHaveBeenCalled()
  })

  it('requires claim-specific confirmation before accepting an ownership miss', async () => {
    const completeJob = writeThatThrows([new Error('D1_ERROR: Network connection lost.'), new DurableJobOwnershipError('job_complete')])
    const { result, message } = await run('complete', { completeJob })

    expect(result).toEqual({ status: 'in-flight', inFlight: { _tag: 'obsolete-delivery' } })
    expect(message.acked).toBe(true)
  })

  it('still acks an obsolete delivery whose first write misses ownership', async () => {
    const completeJob = writeThatThrows([new DurableJobOwnershipError('job_complete')])
    const { result, message } = await run('complete', { completeJob })

    expect(result).toEqual({ status: 'in-flight', inFlight: { _tag: 'obsolete-delivery' } })
    expect(message.acked).toBe(true)
  })

  it('propagates a write defect instead of running the handler-failure path', async () => {
    const defect = new Error('no such column: duration_ms')
    const completeJob = writeThatThrows([defect, defect])
    await expect(run('complete', { completeJob })).rejects.toBe(defect)
    expect(completeJob).toHaveBeenCalledTimes(1)
  })

  it('uses the caller classifier for what counts as transient', async () => {
    const busy = new Error('SQLITE_BUSY: database is locked')
    const releaseJob = writeThatThrows([busy])
    const { result } = await run('throw', { releaseJob }, {
      isTransientError: ({ error }) => error === busy,
    })

    expect(result.status).toBe('errored')
    expect(releaseJob).toHaveBeenCalledTimes(2)
  })
})

describe('isTransientD1WriteError', () => {
  it.each([
    ['D1_ERROR: D1 DB is overloaded. Too many requests queued.', true],
    ['Your account is generating too much load', true],
    ['D1_ERROR: Network connection lost.', true],
    ['D1 DB reset because its code was updated', true],
    ['no such column: duration_ms', false],
    ['D1 DB\'s isolate exceeded its memory limit', false],
  ])('classifies %j as transient=%s', (message, expected) => {
    expect(isTransientD1WriteError({ error: new Error(message) })).toBe(expected)
  })

  it('reads the cause chain of a wrapped driver error', () => {
    const error = new Error('Failed query: UPDATE jobs', { cause: overloaded() })
    expect(isTransientD1WriteError({ error })).toBe(true)
  })
})
