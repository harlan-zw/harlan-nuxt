import type { CloudflareQueue, QueueBatch, QueueMessage } from './types'

export interface FakeQueuedMessage<T> {
  body: T
  opts?: { delaySeconds?: number }
}

export function createFakeQueue<T = unknown>() {
  const messages: Array<FakeQueuedMessage<T>> = []
  const queue: CloudflareQueue<T> = {
    async send(message, opts) {
      messages.push({ body: message, opts })
    },
    async sendBatch(batch, opts) {
      messages.push(...batch.map(message => ({ body: message.body, opts })))
    },
  }

  return {
    queue,
    messages,
    clear() {
      messages.length = 0
    },
  }
}

export function createFakeQueueEnv<T = unknown>(binding = 'QUEUE') {
  const fake = createFakeQueue<T>()
  return {
    env: { [binding]: fake.queue },
    ...fake,
  }
}

export function createQueueMessage<T>(body: T, attempts = 0): QueueMessage<T> & {
  acked: boolean
  retries: Array<{ delaySeconds?: number } | undefined>
} {
  return {
    body,
    attempts,
    acked: false,
    retries: [],
    ack() {
      this.acked = true
    },
    retry(opts) {
      this.retries.push(opts)
    },
  }
}

export function createQueueBatch<T>(queue: string, bodies: T[]): QueueBatch<T> {
  const messages = bodies.map(body => createQueueMessage(body))
  return {
    queue,
    messages,
    ackAll() {
      for (const message of messages)
        message.ack()
    },
    retryAll(opts) {
      for (const message of messages)
        message.retry(opts)
    },
  }
}
