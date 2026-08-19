import type { DurableJobClaimMiss, RunDurableJobMessageOptions } from '#cf-jobs/server'
import { describe, expect, it, vi } from 'vitest'
import { defineJob, defineJobRegistry, runDurableJobMessage } from '#cf-jobs/server'
import { createQueueMessage } from '#cf-jobs/testing'
import { buildJobPayload } from '../src/runtime/server/payload'

// A queue message whose row is still reserved used to retry on a flat 60s.
// Cloudflare counts deliveries, not time, so the message burned `max_retries`
// and dead-lettered with `attempts = 0`, its handler never having run
// (2026-08-18: ~93 phantom `failed_jobs` rows from duplicate enqueues).

interface StoredJob {
  id: string
  queue: string
  payload: Record<string, unknown>
  attempts: number
  batchId: null
}

const registry = defineJobRegistry([
  defineJob({
    name: 'demo/held',
    queue: 'default',
    handle: vi.fn(async () => {}),
  }),
])

function createJobContext() {
  return { env: {}, db: {}, log: {}, jobId: 'job_1', batchId: null, attempt: 1, release: vi.fn(), fail: vi.fn() }
}

type InFlightOptions = Pick<
  RunDurableJobMessageOptions<StoredJob, StoredJob>,
  'inFlightRetryDelaySeconds' | 'maxInFlightRetries'
>

async function runMiss(miss: DurableJobClaimMiss, deliveries: number, opts: InFlightOptions = {}) {
  const message = createQueueMessage({ jobId: 'job_1', queue: 'default' as const }, deliveries)
  const result = await runDurableJobMessage({
    ...opts,
    message,
    lifecycle: {
      claimJob: async () => null,
      resolveClaimMiss: async () => miss,
      completeJob: vi.fn(async () => {}),
      failJob: vi.fn(async () => {}),
    },
    registry,
    toDispatchableJob: (job: StoredJob) => job,
    createJobContext,
  })
  return { result, message }
}

describe('in-flight claim miss backoff', () => {
  it('backs off per delivery instead of retrying on a flat 60s', async () => {
    const first = await runMiss('in-flight', 1)
    const second = await runMiss('in-flight', 2)

    expect(first.message.retries).toEqual([{ delaySeconds: 60 }])
    expect(second.message.retries).toEqual([{ delaySeconds: 120 }])
    expect(first.message.acked).toBe(false)
    expect(second.message.acked).toBe(false)
  })

  it('reports each retry so a consumer can see the row is held', async () => {
    const { result } = await runMiss('in-flight', 2)
    expect(result).toEqual({
      status: 'in-flight',
      inFlight: { _tag: 'retried', deliveries: 2, delaySeconds: 120 },
    })
  })

  it('hands the row to recovery once the retry budget is spent', async () => {
    const { result, message } = await runMiss('in-flight', 3)

    expect(message.retries).toEqual([])
    expect(message.acked).toBe(true)
    expect(result).toEqual({
      status: 'in-flight',
      inFlight: { _tag: 'handed-to-recovery', deliveries: 3 },
    })
  })

  it('spends no delivery at all when the retry budget is zero', async () => {
    const { result, message } = await runMiss('in-flight', 1, { maxInFlightRetries: 0 })

    expect(message.retries).toEqual([])
    expect(message.acked).toBe(true)
    expect(result).toEqual({
      status: 'in-flight',
      inFlight: { _tag: 'handed-to-recovery', deliveries: 1 },
    })
  })

  it('never schedules a delay above the Cloudflare 43200s cap', async () => {
    const { message } = await runMiss('in-flight', 40, { maxInFlightRetries: Number.POSITIVE_INFINITY })
    expect(message.retries).toEqual([{ delaySeconds: 43200 }])

    const explicit = await runMiss('in-flight', 1, { inFlightRetryDelaySeconds: 999_999 })
    expect(explicit.message.retries).toEqual([{ delaySeconds: 43200 }])
  })

  it('accepts a fixed delay and a per-delivery function', async () => {
    const flat = await runMiss('in-flight', 4, { inFlightRetryDelaySeconds: 60, maxInFlightRetries: 10 })
    expect(flat.message.retries).toEqual([{ delaySeconds: 60 }])

    const computed = await runMiss('in-flight', 3, {
      inFlightRetryDelaySeconds: ({ jobId, deliveries }) => (jobId === 'job_1' ? deliveries * 7 : 0),
      maxInFlightRetries: 10,
    })
    expect(computed.message.retries).toEqual([{ delaySeconds: 21 }])
  })

  it('treats a message with no delivery count as the first delivery', async () => {
    const retries: unknown[] = []
    const message = {
      body: { jobId: 'job_1', queue: 'default' as const },
      ack: vi.fn(),
      retry: (opts?: unknown) => {
        retries.push(opts)
      },
    }
    await runDurableJobMessage({
      message,
      lifecycle: {
        claimJob: async () => null,
        resolveClaimMiss: async (): Promise<DurableJobClaimMiss> => 'in-flight',
        completeJob: vi.fn(async () => {}),
        failJob: vi.fn(async () => {}),
      },
      registry,
      toDispatchableJob: (job: StoredJob) => job,
      createJobContext,
    })
    expect(retries).toEqual([{ delaySeconds: 60 }])
  })

  it('still acks a settled or missing row without ever retrying it', async () => {
    for (const miss of ['already-resolved', 'not-found'] as const) {
      const { result, message } = await runMiss(miss, 9)
      expect(message.acked).toBe(true)
      expect(message.retries).toEqual([])
      expect(result).toEqual({ status: miss })
    }
  })

  it('leaves a successful claim untouched', async () => {
    const storedJob: StoredJob = {
      id: 'job_1',
      queue: 'default',
      payload: buildJobPayload('demo/held', {}),
      attempts: 1,
      batchId: null,
    }
    const message = createQueueMessage({ jobId: 'job_1', queue: 'default' as const }, 7)
    const result = await runDurableJobMessage({
      message,
      lifecycle: {
        claimJob: async () => storedJob,
        resolveClaimMiss: async (): Promise<DurableJobClaimMiss> => 'in-flight',
        completeJob: vi.fn(async () => {}),
        failJob: vi.fn(async () => {}),
      },
      registry,
      toDispatchableJob: (job: StoredJob) => job,
      createJobContext,
    })

    expect(result.status).toBe('completed')
    expect(message.retries).toEqual([])
    expect(message.acked).toBe(true)
  })
})
