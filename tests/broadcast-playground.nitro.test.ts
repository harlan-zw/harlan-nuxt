import { fileURLToPath } from 'node:url'
import { $fetch, fetch, setup, url } from '@nuxt/test-utils/e2e'
import { describe, expect, it } from 'vitest'

interface BroadcastEnvelope<T = unknown> {
  channel: string
  event: string
  data: T
}

interface WsClient {
  ws: WebSocket
  send: (payload: unknown) => void
  waitFor: <T = unknown>(label: string, predicate: (message: BroadcastEnvelope<T>) => boolean) => Promise<BroadcastEnvelope<T>>
}

describe('broadcast playground', async () => {
  await setup({
    rootDir: fileURLToPath(new URL('./fixtures/broadcast-playground', import.meta.url)),
    server: true,
    browser: false,
  })

  it('renders the minimal playground app', async () => {
    const html = await fetch('/').then(r => r.text())
    expect(html).toContain('cf-jobs broadcast playground')
  })

  it('streams job, batch, and app events through the module websocket route', async () => {
    const client = await createWsClient('/__cf-jobs/ws')
    try {
      await client.waitFor('ready', message => message.channel === 'system' && message.event === 'ready')

      client.send({
        event: 'subscribe',
        channels: ['job:playground-job', 'batch:playground-batch', 'site:playground-site'],
      })

      const subscribed = await client.waitFor<{ channels: string[], rejected: string[] }>(
        'subscribed',
        message => message.channel === 'system' && message.event === 'subscribed',
      )
      expect(subscribed.data.channels.sort()).toEqual([
        'batch:playground-batch',
        'job:playground-job',
        'site:playground-site',
      ])
      expect(subscribed.data.rejected).toEqual([])

      const jobPublish = await $fetch<{ sent: boolean, channel: string, event: string }>('/api/publish', {
        method: 'POST',
        body: { kind: 'job', jobId: 'playground-job' },
      })
      expect(jobPublish).toEqual({ sent: true, channel: 'job:playground-job', event: 'job.completed' })

      const job = await client.waitFor<{ status: string, result: { message: string } }>(
        'job.completed',
        message => message.channel === 'job:playground-job' && message.event === 'job.completed',
      )
      expect(job.data.status).toBe('completed')
      expect(job.data.result).toEqual({ message: 'done' })

      await $fetch('/api/publish', {
        method: 'POST',
        body: { kind: 'batch', batchId: 'playground-batch' },
      })
      const batch = await client.waitFor<{ completed: number, total: number, finishedAt: number | null }>(
        'batch.progress',
        message => message.channel === 'batch:playground-batch' && message.event === 'batch.progress',
      )
      expect(batch.data).toMatchObject({ completed: 1, total: 1, finishedAt: 1 })

      await $fetch('/api/publish', {
        method: 'POST',
        body: { kind: 'site', siteId: 'playground-site' },
      })
      const site = await client.waitFor<{ ok: boolean, siteId: string }>(
        'playground.site',
        message => message.channel === 'site:playground-site' && message.event === 'playground.site',
      )
      expect(site.data).toEqual({ ok: true, siteId: 'playground-site' })
    }
    finally {
      client.ws.close()
    }
  })

  it('runs subscription authorization hooks', async () => {
    const client = await createWsClient('/__cf-jobs/ws')
    try {
      await client.waitFor('ready', message => message.channel === 'system' && message.event === 'ready')
      client.send({ event: 'subscribe', channels: ['site:blocked'] })

      const subscribed = await client.waitFor<{ channels: string[], rejected: string[] }>(
        'blocked subscription result',
        message => message.channel === 'system' && message.event === 'subscribed',
      )
      expect(subscribed.data.channels).toEqual([])
      expect(subscribed.data.rejected).toEqual(['site:blocked'])
    }
    finally {
      client.ws.close()
    }
  })
})

function toWsUrl(path: string): string {
  return url(path).replace(/^http/, 'ws')
}

async function createWsClient(path: string): Promise<WsClient> {
  const messages: BroadcastEnvelope[] = []
  const waiters = new Set<{
    label: string
    predicate: (message: BroadcastEnvelope) => boolean
    resolve: (message: BroadcastEnvelope) => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }>()

  const ws = new WebSocket(toWsUrl(path))
  ws.addEventListener('message', (event) => {
    const message = parseMessage(event.data)
    if (!message)
      return
    messages.push(message)
    for (const waiter of waiters) {
      if (!waiter.predicate(message))
        continue
      clearTimeout(waiter.timeout)
      waiters.delete(waiter)
      waiter.resolve(message)
    }
  })

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out opening ${path}`)), 5000)
    ws.addEventListener('open', () => {
      clearTimeout(timeout)
      resolve()
    }, { once: true })
    ws.addEventListener('error', () => {
      clearTimeout(timeout)
      reject(new Error(`Failed to open ${path}`))
    }, { once: true })
  })

  return {
    ws,
    send(payload) {
      ws.send(JSON.stringify(payload))
    },
    waitFor(label, predicate) {
      const match = messages.find(message => predicate(message as never))
      if (match)
        return Promise.resolve(match as never)

      return new Promise((resolve, reject) => {
        const waiter = {
          label,
          predicate: predicate as (message: BroadcastEnvelope) => boolean,
          resolve: resolve as (message: BroadcastEnvelope) => void,
          reject,
          timeout: setTimeout(() => {
            waiters.delete(waiter)
            reject(new Error(`Timed out waiting for ${label}. Seen: ${messages.map(m => `${m.channel}:${m.event}`).join(', ')}`))
          }, 5000),
        }
        waiters.add(waiter)
      })
    },
  }
}

function parseMessage(input: unknown): BroadcastEnvelope | null {
  if (typeof input !== 'string')
    return null
  try {
    const parsed = JSON.parse(input)
    if (!parsed || typeof parsed !== 'object')
      return null
    if (typeof parsed.channel !== 'string' || typeof parsed.event !== 'string')
      return null
    return parsed as BroadcastEnvelope
  }
  catch {
    return null
  }
}
