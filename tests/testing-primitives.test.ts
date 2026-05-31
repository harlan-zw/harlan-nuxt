import { describe, expect, it } from 'vitest'
import {
  createFakeQueue,
  createFakeQueueEnv,
  createQueueBatch,
  createQueueMessage,
} from '#cf-jobs/testing'

// Meta-tests: pin the contracts of the low-level test fakes themselves. The
// harness (`createJobTestHarness`) is covered by harness.test.ts; these guard
// the producer/consumer fakes everything else is built on.

describe('createFakeQueue', () => {
  it('records send() body and per-call opts in order', async () => {
    const { queue, messages } = createFakeQueue<{ id: string }>()

    await queue.send({ id: 'a' })
    await queue.send({ id: 'b' }, { delaySeconds: 30 })

    expect(messages).toEqual([
      { body: { id: 'a' }, opts: undefined },
      { body: { id: 'b' }, opts: { delaySeconds: 30 } },
    ])
  })

  it('sendBatch records each message and falls back to the batch opts', async () => {
    const { queue, messages } = createFakeQueue<{ id: string }>()

    await queue.sendBatch(
      [{ body: { id: 'a' } }, { body: { id: 'b' } }],
      { delaySeconds: 10 },
    )

    expect(messages).toStrictEqual([
      { body: { id: 'a' }, opts: { delaySeconds: 10 } },
      { body: { id: 'b' }, opts: { delaySeconds: 10 } },
    ])
  })

  it('sendBatch lets per-message delaySeconds/contentType override the batch opts', async () => {
    const { queue, messages } = createFakeQueue<{ id: string }>()

    await queue.sendBatch(
      [
        { body: { id: 'a' }, delaySeconds: 5 },
        { body: { id: 'b' }, contentType: 'json' },
        { body: { id: 'c' } },
      ],
      { delaySeconds: 99 },
    )

    // A message specifying either field gets its own `{ delaySeconds, contentType }`
    // pair (the unspecified one is explicitly `undefined`); otherwise the batch opts win.
    expect(messages).toStrictEqual([
      { body: { id: 'a' }, opts: { delaySeconds: 5, contentType: undefined } },
      { body: { id: 'b' }, opts: { delaySeconds: undefined, contentType: 'json' } },
      { body: { id: 'c' }, opts: { delaySeconds: 99 } },
    ])
  })

  it('clear() truncates the recorded log in place (same array reference)', async () => {
    const fake = createFakeQueue()
    await fake.queue.send('x')
    const ref = fake.messages

    fake.clear()

    expect(fake.messages).toHaveLength(0)
    expect(fake.messages).toBe(ref)
  })
})

describe('createFakeQueueEnv', () => {
  it('exposes the queue under the default binding and shares the message log', async () => {
    const { env, queue, messages } = createFakeQueueEnv<string>()

    expect(env.QUEUE).toBe(queue)
    await env.QUEUE.send('hi')
    expect(messages).toEqual([{ body: 'hi', opts: undefined }])
  })

  it('honours a custom binding name', () => {
    const { env } = createFakeQueueEnv('QUEUE_CRITICAL')

    expect(env.QUEUE_CRITICAL).toBeDefined()
    expect(env.QUEUE).toBeUndefined()
  })
})

describe('createQueueMessage', () => {
  it('defaults attempts to 0 and tracks ack()', () => {
    const message = createQueueMessage({ hello: 'world' })

    expect(message.id).toBeUndefined()
    expect(message.attempts).toBe(0)
    expect(message.acked).toBe(false)

    message.ack()
    expect(message.acked).toBe(true)
  })

  it('carries the given id/attempts and records retry() opts in order', () => {
    const message = createQueueMessage('body', 2, 'msg_1')

    expect(message.id).toBe('msg_1')
    expect(message.attempts).toBe(2)

    message.retry()
    message.retry({ delaySeconds: 15 })

    expect(message.retries).toEqual([undefined, { delaySeconds: 15 }])
  })
})

describe('createQueueBatch', () => {
  it('builds messages from bodies and maps optional ids positionally', () => {
    const batch = createQueueBatch('critical', [{ n: 1 }, { n: 2 }], { ids: ['x', 'y'] })

    expect(batch.queue).toBe('critical')
    expect(batch.messages.map(m => m.id)).toEqual(['x', 'y'])
    expect(batch.messages.map(m => m.body)).toEqual([{ n: 1 }, { n: 2 }])
    expect(batch.messages.every(m => m.attempts === 0)).toBe(true)
  })

  it('leaves ids undefined when none are supplied', () => {
    const batch = createQueueBatch('q', ['a', 'b'])

    expect(batch.messages.map(m => m.id)).toEqual([undefined, undefined])
  })

  it('ackAll() flips ackedAll and acks every message', () => {
    const batch = createQueueBatch('q', ['a', 'b'])

    expect(batch.ackedAll).toBe(false)
    batch.ackAll()

    expect(batch.ackedAll).toBe(true)
    expect(batch.messages.every(m => m.acked)).toBe(true)
  })

  it('retryAll() records the opts once and retries every message with them', () => {
    const batch = createQueueBatch('q', ['a', 'b'])

    batch.retryAll({ delaySeconds: 20 })

    expect(batch.retriedAll).toEqual([{ delaySeconds: 20 }])
    expect(batch.messages.map(m => m.retries)).toEqual([
      [{ delaySeconds: 20 }],
      [{ delaySeconds: 20 }],
    ])
  })
})
