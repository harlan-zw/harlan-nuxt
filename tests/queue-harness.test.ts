import { describe, expect, it } from 'vitest'
import { defineJob, defineJobRegistry } from '#cf-jobs/server'
import { createQueueTestHarness } from '#cf-jobs/testing'

interface Sink {
  processed: string[]
  shipped: string[]
}

function buildRegistry(sink: Sink) {
  return defineJobRegistry([
    defineJob({
      name: 'order/process',
      queue: 'default',
      async handle(payload: { orderId: string, mode?: 'fail' | 'release' | 'chain' | 'throwOnce' }, ctx: any) {
        if (payload.mode === 'fail')
          return ctx.fail('bad order')
        if (payload.mode === 'release')
          return ctx.release(30)
        if (payload.mode === 'throwOnce' && ctx.attempt < 2)
          throw new Error('transient boom')

        sink.processed.push(payload.orderId)
        if (payload.mode === 'chain')
          await ctx.env.QUEUE_DEFAULT.send({ _task: 'order/ship', orderId: payload.orderId })
      },
    }),
    defineJob({
      name: 'order/ship',
      queue: 'default',
      async handle(payload: { orderId: string }) {
        sink.shipped.push(payload.orderId)
      },
    }),
  ])
}

function harness(sink: Sink) {
  return createQueueTestHarness({
    registry: buildRegistry(sink),
    queues: { default: 'QUEUE_DEFAULT' },
  })
}

describe('createQueueTestHarness (default consumer)', () => {
  it('processes a dispatched job through the queue → consumer → handler', async () => {
    const sink: Sink = { processed: [], shipped: [] }
    const q = harness(sink)

    q.env.QUEUE_DEFAULT.send({ _task: 'order/process', orderId: 'A1' })
    const summary = await q.work()

    expect(summary).toMatchObject({ delivered: 1, acked: 1, retried: 0 })
    expect(sink.processed).toEqual(['A1'])
    q.assertProcessed('order/process')
    q.assertDispatched('order/process')
    q.assertNothingPending()
  })

  it('redelivers a released job only after the backoff elapses', async () => {
    const sink: Sink = { processed: [], shipped: [] }
    const q = harness(sink)

    q.env.QUEUE_DEFAULT.send({ _task: 'order/process', orderId: 'A2', mode: 'release' })
    await q.work()

    q.assertReleased('order/process', { delay: 30 })
    expect(q.pending()).toHaveLength(1) // re-queued for +30s
    await q.work() // nothing due yet
    expect(sink.processed).toEqual([])

    q.advanceTime(30)
    await q.work() // now due — but it releases again (handler always releases)
    q.assertRetried('order/process', 2)
  })

  it('acks a permanently failed job (ctx.fail) without redelivering', async () => {
    const sink: Sink = { processed: [], shipped: [] }
    const q = harness(sink)

    q.env.QUEUE_DEFAULT.send({ _task: 'order/process', orderId: 'A3', mode: 'fail' })
    await q.work()

    q.assertFailed('order/process')
    q.assertRetried('order/process', 0)
    q.assertNothingPending()
  })

  it('retries a thrown job with backoff and succeeds on redelivery', async () => {
    const sink: Sink = { processed: [], shipped: [] }
    const q = harness(sink)

    q.env.QUEUE_DEFAULT.send({ _task: 'order/process', orderId: 'A4', mode: 'throwOnce' })
    const total = await q.runUntilEmpty()

    expect(sink.processed).toEqual(['A4']) // attempt 2 succeeded
    q.assertRetried('order/process', 1)
    expect(total.delivered).toBe(2)
    q.assertNothingPending()
  })

  it('drains a chained continuation (Bus-style) via runUntilEmpty', async () => {
    const sink: Sink = { processed: [], shipped: [] }
    const q = harness(sink)

    q.env.QUEUE_DEFAULT.send({ _task: 'order/process', orderId: 'A5', mode: 'chain' })
    await q.runUntilEmpty()

    expect(sink.processed).toEqual(['A5'])
    expect(sink.shipped).toEqual(['A5']) // continuation ran
    q.assertProcessed('order/ship')
    q.assertDispatched('order/ship')
    q.assertNothingPending()
  })

  it('caps redelivery at maxAttempts (DLQ)', async () => {
    const q = createQueueTestHarness({
      registry: defineJobRegistry([
        defineJob({
          name: 'order/process',
          queue: 'default',
          async handle() {
            throw new Error('always fails')
          },
        }),
      ]),
      queues: { default: 'QUEUE_DEFAULT' },
      maxAttempts: 3,
    })

    q.send('QUEUE_DEFAULT', { _task: 'order/process', orderId: 'A6' })
    await q.runUntilEmpty()

    // attempts 1,2,3 each retry; attempt 3 hits the cap → DLQ, no 4th enqueue
    q.assertRetried('order/process', 2)
    q.assertNothingPending()
  })
})

describe('createQueueTestHarness (custom consumer)', () => {
  it('delivers batches to a custom consumer and records queue mechanics', async () => {
    const seen: Array<{ queue: string, jobId: string }> = []

    const q = createQueueTestHarness({
      registry: buildRegistry({ processed: [], shipped: [] }),
      queues: { default: 'QUEUE_DEFAULT' },
      // An app's own consumer reads `{ jobId }` messages and decides ack/retry.
      consumer: async (batch) => {
        for (const message of batch.messages) {
          const body = message.body as { jobId: string }
          seen.push({ queue: batch.queue, jobId: body.jobId })
          if (body.jobId === 'retry-me')
            message.retry({ delaySeconds: 10 })
          else
            message.ack()
        }
      },
    })

    q.send('QUEUE_DEFAULT', { jobId: 'ok-1' })
    q.send('QUEUE_DEFAULT', { jobId: 'retry-me' })
    await q.work()

    expect(seen).toEqual([
      { queue: 'default', jobId: 'ok-1' },
      { queue: 'default', jobId: 'retry-me' },
    ])
    q.assertRetried('retry-me', 1)
    expect(q.pending()).toHaveLength(1) // retry-me re-queued for +10s

    q.advanceTime(10)
    await q.work()
    q.assertRetried('retry-me', 2)
  })

  it('makes default-consumer-only assertions fail loudly', () => {
    const q = createQueueTestHarness({
      registry: buildRegistry({ processed: [], shipped: [] }),
      queues: { default: 'QUEUE_DEFAULT' },
      consumer: async (batch) => {
        for (const m of batch.messages) m.ack()
      },
    })

    expect(() => q.assertProcessed('order/process')).toThrow(/only works with the default consumer/)
    expect(() => q.assertReleased('order/process')).toThrow(/default consumer/)
  })
})
