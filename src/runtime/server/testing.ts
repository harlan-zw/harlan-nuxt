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
      for (const message of batch) {
        const perMessage = (message.delaySeconds !== undefined || message.contentType !== undefined)
          ? { delaySeconds: message.delaySeconds, contentType: message.contentType }
          : undefined
        messages.push({ body: message.body, opts: perMessage ?? opts })
      }
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

export function createQueueMessage<T>(body: T, attempts = 0, id?: string): QueueMessage<T> & {
  acked: boolean
  retries: Array<{ delaySeconds?: number } | undefined>
} {
  return {
    id,
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

export function createQueueBatch<T>(queue: string, bodies: T[], opts?: { ids?: string[] }): QueueBatch<T> & {
  ackedAll: boolean
  retriedAll: Array<{ delaySeconds?: number } | undefined>
} {
  const messages = bodies.map((body, i) => createQueueMessage(body, 0, opts?.ids?.[i]))
  const batch = {
    queue,
    messages,
    ackedAll: false,
    retriedAll: [] as Array<{ delaySeconds?: number } | undefined>,
    ackAll() {
      batch.ackedAll = true
      for (const message of messages) message.ack()
    },
    retryAll(retryOpts: { delaySeconds?: number } | undefined) {
      batch.retriedAll.push(retryOpts)
      for (const message of messages) message.retry(retryOpts)
    },
  }
  return batch
}

