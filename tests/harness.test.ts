import { describe, expect, it, vi } from 'vitest'
import { defineJob, defineJobRegistry } from '#cf-jobs/server'
import { createJobTestHarness } from '#cf-jobs/testing'

interface Sent {
  emailed: string[]
  shipped: string[]
}

function buildRegistry(sink: Sent, sendQueue?: { send: (q: string, body: unknown) => Promise<void> }) {
  return defineJobRegistry([
    defineJob({
      name: 'order/ship',
      queue: 'critical',
      async handle(payload: { orderId: string, fail?: boolean, release?: boolean }, ctx) {
        if (payload.fail)
          return ctx.fail('boom')
        if (payload.release)
          return ctx.release(30)
        sink.shipped.push(payload.orderId)
        // a job that fans out to another queue via the producer binding
        await sendQueue?.send('standard', { _task: 'email/send', orderId: payload.orderId })
      },
    }),
    defineJob({
      name: 'email/send',
      queue: 'standard',
      async handle(payload: { orderId: string }) {
        sink.emailed.push(payload.orderId)
      },
    }),
  ])
}

describe('createJobTestHarness', () => {
  it('runInline runs the handler synchronously and reports success', async () => {
    const sink: Sent = { emailed: [], shipped: [] }
    const h = createJobTestHarness(buildRegistry(sink))

    const res = await h.runInline('order/ship', { orderId: 'A1' })

    expect(res.success).toBe(true)
    expect(res.released).toBe(false)
    expect(res.failed).toBe(false)
    expect(sink.shipped).toEqual(['A1'])
  })

  it('runInline surfaces ctx.release() and ctx.fail()', async () => {
    const sink: Sent = { emailed: [], shipped: [] }
    const h = createJobTestHarness(buildRegistry(sink))

    const released = await h.runInline('order/ship', { orderId: 'A2', release: true })
    expect(released.released).toBe(true)
    expect(released.delaySeconds).toBe(30)

    const failed = await h.runInline('order/ship', { orderId: 'A3', fail: true })
    expect(failed.failed).toBe(true)
  })

  it('runInline passes env/db/log into ctx', async () => {
    const log = { info: vi.fn() }
    const registry = defineJobRegistry([
      defineJob({
        name: 'ctx/probe',
        queue: 'critical',
        async handle(_payload: { x: number }, ctx: any) {
          ctx.log.info(ctx.env.GREETING)
          ctx.db.calls.push(ctx.jobId)
        },
      }),
    ])
    const db = { calls: [] as string[] }
    const h = createJobTestHarness(registry, { env: { GREETING: 'hi' }, db, log })

    await h.runInline('ctx/probe', { x: 1 }, { jobId: 'job_42' })

    expect(log.info).toHaveBeenCalledWith('hi')
    expect(db.calls).toEqual(['job_42'])
  })

  it('fakeJobs records sends and supports Laravel-style assertions', async () => {
    const sink: Sent = { emailed: [], shipped: [] }
    const registry = buildRegistry(sink)
    const h = createJobTestHarness(registry)
    const fake = h.fakeJobs(['QUEUE_STANDARD'])

    const queue = fake.env.QUEUE_STANDARD
    await queue.send(registry.buildPayload('email/send', { orderId: 'A1' }))
    await queue.send(registry.buildPayload('email/send', { orderId: 'A2' }))

    fake.assertSent('email/send')
    fake.assertSent('email/send', payload => payload.orderId === 'A1')
    fake.assertSentTimes('email/send', 2)
    fake.assertSentOn('standard', 'email/send', p => p.orderId === 'A2')
    fake.assertNotSent('order/ship')

    expect(() => fake.assertNothingSent()).toThrow()
    expect(() => fake.assertSent('email/send', p => p.orderId === 'nope')).toThrow()
    expect(() => fake.assertSentOn('critical', 'email/send')).toThrow(/routes to 'standard'/)
  })

  it('drainOutbox claims and runs durable records once', async () => {
    const sink: Sent = { emailed: [], shipped: [] }
    const h = createJobTestHarness(buildRegistry(sink))

    const outbox = [
      { id: '1', payload: JSON.stringify({ _task: 'order/ship', orderId: 'O1' }) },
      { id: '2', payload: JSON.stringify({ _task: 'email/send', orderId: 'O1' }) },
      { id: '3', payload: JSON.stringify({ _task: 'order/ship', orderId: 'O2', fail: true }) },
    ]
    const completed: string[] = []
    const failed: string[] = []

    const summary = await h.drainOutbox({
      next: () => outbox.shift(),
      onComplete: record => void completed.push(record.id),
      onFailed: record => void failed.push(record.id),
    })

    expect(summary).toEqual({ processed: 3, completed: 2, released: 0, failed: 1 })
    expect(completed).toEqual(['1', '2'])
    expect(failed).toEqual(['3'])
    expect(sink.shipped).toEqual(['O1'])
    expect(sink.emailed).toEqual(['O1'])
  })
})

describe('createJobTestHarness — Laravel-parity assertions', () => {
  it('records run outcomes for assertRan/assertReleased/assertFailed', async () => {
    const sink: Sent = { emailed: [], shipped: [] }
    const h = createJobTestHarness(buildRegistry(sink))

    await h.runInline('order/ship', { orderId: 'A1' })
    await h.runInline('order/ship', { orderId: 'A2', release: true })
    await h.runInline('order/ship', { orderId: 'A3', fail: true })

    h.assertRan('order/ship')
    h.assertRan('order/ship', result => result.success)
    h.assertReleased('order/ship')
    h.assertFailed('order/ship')

    expect(() => h.assertRan('email/send')).toThrow()
    expect(() => h.assertFailed('email/send')).toThrow()
    expect(() => h.assertNothingFailed()).toThrow(/order\/ship/)
  })

  it('assertNothingFailed passes when every run succeeds', async () => {
    const sink: Sent = { emailed: [], shipped: [] }
    const h = createJobTestHarness(buildRegistry(sink))

    await h.runInline('email/send', { orderId: 'A1' })

    h.assertNothingFailed()
    h.assertRan('email/send')
  })

  it('assertSentWithDelay checks the message delay', async () => {
    const sink: Sent = { emailed: [], shipped: [] }
    const registry = buildRegistry(sink)
    const fake = createJobTestHarness(registry).fakeJobs(['QUEUE'])

    await fake.env.QUEUE.send(registry.buildPayload('email/send', { orderId: 'A1' }), { delaySeconds: 60 })
    await fake.env.QUEUE.send(registry.buildPayload('order/ship', { orderId: 'A2' }))

    fake.assertSentWithDelay('email/send', 60)
    fake.assertSentWithDelay('email/send')
    expect(() => fake.assertSentWithDelay('email/send', 30)).toThrow()
    expect(() => fake.assertSentWithDelay('order/ship')).toThrow()
  })

  it('assertChained checks a job carries a continuation chain', async () => {
    const sink: Sent = { emailed: [], shipped: [] }
    const registry = buildRegistry(sink)
    const fake = createJobTestHarness(registry).fakeJobs(['QUEUE'])

    await fake.env.QUEUE.send({
      ...registry.buildPayload('order/ship', { orderId: 'A1' }),
      _continuations: { then: [{ name: 'email/send', payload: { orderId: 'A1' } }] },
    })

    fake.assertChained('order/ship', ['email/send'])
    expect(() => fake.assertChained('order/ship', ['order/ship'])).toThrow(/chain/)
  })

  it('assertBatched checks jobs dispatched together via sendBatch', async () => {
    const sink: Sent = { emailed: [], shipped: [] }
    const registry = buildRegistry(sink)
    const fake = createJobTestHarness(registry).fakeJobs(['QUEUE'])

    await fake.env.QUEUE.sendBatch([
      { body: registry.buildPayload('email/send', { orderId: 'A1' }) },
      { body: registry.buildPayload('email/send', { orderId: 'A2' }) },
    ])

    fake.assertBatched()
    fake.assertBatched(names => names.length === 2 && names.every(name => name === 'email/send'))
    expect(() => fake.assertBatched(names => names.length === 3)).toThrow()
  })
})
