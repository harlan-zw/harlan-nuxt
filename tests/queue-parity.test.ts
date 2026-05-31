import type { CloudflareQueue } from '../src/runtime/server/types'
import { describe, expect, it, vi } from 'vitest'
import { createFakeQueue } from '#cf-jobs/testing'
import { createDevQueueRuntime } from '../src/runtime/server/dev'

// The test fake (`createFakeQueue`) RECORDS producer sends; the dev polyfill
// (`createDevQueueRuntime`) DELIVERS them to a consumer. Both implement the same
// `CloudflareQueue` producer contract real Cloudflare Queues expose, so a passing
// fake-based test reflects dev/production producer behaviour. These tests pin that
// the two agree on what a producer call conveys. (The dev polyfill → consumer loop
// itself is covered by dev.test.ts; real Cloudflare delivery by the e2e tier.)

function devProducer(onBody: (body: unknown, queueName: string) => void) {
  const runtime = createDevQueueRuntime({
    queues: { default: 'JOBS' },
    onBatch: ({ batch }) => {
      for (const message of batch.messages)
        onBody(message.body, batch.queue)
    },
  })
  return { queue: runtime.env.JOBS as CloudflareQueue<Record<string, unknown>>, dispose: runtime.dispose }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('producer contract parity: fake queue vs dev polyfill', () => {
  it('send() conveys the same single body', async () => {
    const fake = createFakeQueue<Record<string, unknown>>()
    await fake.queue.send({ _task: 'a', n: 1 })

    const delivered: unknown[] = []
    const dev = devProducer(body => delivered.push(body))
    await dev.queue.send({ _task: 'a', n: 1 })
    await tick()
    dev.dispose()

    expect(fake.messages.map(m => m.body)).toEqual([{ _task: 'a', n: 1 }])
    expect(delivered).toEqual(fake.messages.map(m => m.body))
  })

  it('sendBatch() fans out every message body in order', async () => {
    const bodies = [{ _task: 'a' }, { _task: 'b' }, { _task: 'c' }]

    const fake = createFakeQueue<Record<string, unknown>>()
    await fake.queue.sendBatch(bodies.map(body => ({ body })))

    const delivered: unknown[] = []
    const dev = devProducer(body => delivered.push(body))
    await dev.queue.sendBatch(bodies.map(body => ({ body })))
    await tick()
    dev.dispose()

    expect(fake.messages.map(m => m.body)).toEqual(bodies)
    expect(delivered).toEqual(bodies)
  })

  it('per-message delaySeconds takes precedence over the batch delay in both', async () => {
    vi.useFakeTimers()

    // Fake: records the effective per-message delay (own delay, else batch delay).
    const fake = createFakeQueue<Record<string, unknown>>()
    await fake.queue.sendBatch(
      [{ body: { _task: 'fast' }, delaySeconds: 1 }, { body: { _task: 'slow' } }],
      { delaySeconds: 10 },
    )
    expect(fake.messages.map(m => m.opts?.delaySeconds)).toEqual([1, 10])

    // Dev: delivery timing honours the same precedence.
    const order: string[] = []
    const dev = devProducer(body => order.push((body as { _task: string })._task))
    await dev.queue.sendBatch(
      [{ body: { _task: 'fast' }, delaySeconds: 1 }, { body: { _task: 'slow' } }],
      { delaySeconds: 10 },
    )

    await vi.advanceTimersByTimeAsync(1000)
    expect(order).toEqual(['fast']) // per-message 1s fired; batch 10s has not
    await vi.advanceTimersByTimeAsync(9000)
    expect(order).toEqual(['fast', 'slow'])

    dev.dispose()
    vi.useRealTimers()
  })
})
