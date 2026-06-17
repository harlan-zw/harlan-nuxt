import { describe, expect, it, vi } from 'vitest'
import {
  cfJobBatchChannel,
  cfJobChannel,
  cfJobQueueChannel,
  cfJobsBroadcastTopic,
  createCfJobsBroadcastBatchProgressHandler,
  createCfJobsBroadcastRepositoryHooks,
  defineJob,
  isCfJobsBroadcastChannel,
  parseCfJobsBroadcastCommand,
  publishCfJobsBroadcast,
} from '#cf-jobs/server'
import broadcastWsHandler from '../src/runtime/server/handlers/broadcast-ws'

function createBroadcastEnv() {
  const published: Array<{ topic: string, data: unknown, opts?: { compress?: boolean } }> = []
  const stub = {
    publish: vi.fn(async (topic: string, data: unknown, opts?: { compress?: boolean }) => {
      published.push({ topic, data, opts })
    }),
  }
  return {
    published,
    stub,
    env: {
      $DurableObject: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => stub),
      },
    },
  }
}

interface WebSocketHandlerMarker {
  __is_handler__?: boolean
  __websocket__?: unknown
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'j1',
    queue: 'crawl',
    job_type: 'crawl/site',
    attempts: 2,
    max_attempts: 3,
    batch_id: 'b1',
    site_id: 's1',
    user_id: 7,
    duration_ms: 42,
    payload: JSON.stringify({ _task: 'crawl/site', siteId: 's1', tenantId: 't1' }),
    ...overrides,
  } as never
}

async function flushBroadcast(): Promise<void> {
  for (let i = 0; i < 10; i++)
    await Promise.resolve()
}

describe('cf-jobs broadcast protocol', () => {
  it('builds job channels and durable-object topics', () => {
    expect(cfJobChannel('j1')).toBe('job:j1')
    expect(cfJobBatchChannel('b1')).toBe('batch:b1')
    expect(cfJobQueueChannel('crawl')).toBe('queue:crawl')
    expect(cfJobsBroadcastTopic('job:j1')).toBe('cf-jobs:job:j1')
    expect(cfJobsBroadcastTopic('tenant:t1')).toBe('cf-jobs:tenant:t1')
    expect(isCfJobsBroadcastChannel('../bad')).toBe(false)
  })

  it('parses subscribe/unsubscribe client commands', () => {
    expect(parseCfJobsBroadcastCommand(JSON.stringify({ event: 'subscribe', channel: 'job:j1' })))
      .toEqual({ event: 'subscribe', channels: ['job:j1'] })
    expect(parseCfJobsBroadcastCommand({ event: 'unsubscribe', channels: ['job:j1', 'job:j1', '../bad'] }))
      .toEqual({ event: 'unsubscribe', channels: ['job:j1'] })
    expect(parseCfJobsBroadcastCommand({ event: 'ping' })).toEqual({ event: 'ping' })
    expect(parseCfJobsBroadcastCommand('{bad')).toBeNull()
  })

  it('publishes envelopes through Nitro durable object pubsub', async () => {
    const { env, published } = createBroadcastEnv()

    await expect(
      publishCfJobsBroadcast(env, 'job:j1', 'job.completed', { ok: true }, { compress: true }),
    )
      .resolves
      .toBe(true)

    expect(published).toHaveLength(1)
    expect(published[0]!.topic).toBe('cf-jobs:job:j1')
    expect(JSON.parse(published[0]!.data as string)).toEqual({
      channel: 'job:j1',
      event: 'job.completed',
      data: { ok: true },
    })
    expect(published[0]!.opts).toEqual({ compress: true })
  })

  it('returns false when the durable object binding is missing', async () => {
    await expect(publishCfJobsBroadcast({}, 'job:j1', 'job.completed', {})).resolves.toBe(false)
  })

  it('exposes Nitro and CrossWS websocket handler metadata', () => {
    const handler = broadcastWsHandler as typeof broadcastWsHandler & WebSocketHandlerMarker
    const response = handler() as Response & { crossws?: unknown }

    expect(handler.__is_handler__).toBe(true)
    expect(handler.__websocket__).toMatchObject({
      open: expect.any(Function),
      message: expect.any(Function),
      close: expect.any(Function),
      error: expect.any(Function),
    })
    expect(response.status).toBe(426)
    expect(response.crossws).toBe(handler.__websocket__)
  })
})

describe('cf-jobs broadcast lifecycle adapters', () => {
  it('fans default job lifecycle events out to job, queue, and batch channels', async () => {
    const { env, published } = createBroadcastEnv()
    const hooks = createCfJobsBroadcastRepositoryHooks(env)

    hooks.onJobCompleted!({ job: job(), durationMs: 25, result: { reportId: 'r1' } })
    await flushBroadcast()

    expect(published.map(p => p.topic).sort()).toEqual([
      'cf-jobs:batch:b1',
      'cf-jobs:job:j1',
      'cf-jobs:queue:crawl',
    ])
    const envelope = JSON.parse(published.find(p => p.topic === 'cf-jobs:job:j1')!.data as string)
    expect(envelope.event).toBe('job.completed')
    expect(envelope.data).toMatchObject({
      jobName: 'crawl/site',
      jobId: 'j1',
      queue: 'crawl',
      jobType: 'crawl/site',
      status: 'completed',
      durationMs: 25,
      result: { reportId: 'r1' },
    })
  })

  it('can omit completion results', async () => {
    const { env, published } = createBroadcastEnv()
    const hooks = createCfJobsBroadcastRepositoryHooks(env, { includeResult: false })

    hooks.onJobCompleted!({ job: job({ batch_id: null, site_id: null, user_id: null }), durationMs: 25, result: { secret: true } })
    await flushBroadcast()

    const envelope = JSON.parse(published.find(p => p.topic === 'cf-jobs:job:j1')!.data as string)
    expect(envelope.data.result).toBeUndefined()
  })

  it('uses the job definition broadcast message when one is declared', async () => {
    const { env, published } = createBroadcastEnv()
    const definition = defineJob({
      name: 'crawl/site',
      queue: 'crawl',
      async handle(_payload: { siteId: string, tenantId: string }) {},
      broadcast({ payload, status }) {
        return {
          channel: `tenant:${payload.tenantId}`,
          event: `crawl.${status}`,
          data: { siteId: payload.siteId, status },
        }
      },
    })
    const hooks = createCfJobsBroadcastRepositoryHooks(env, {}, {
      registry: {
        async loadJobDefinition(name) {
          return name === definition.name ? definition : undefined
        },
      },
    })

    hooks.onJobCompleted!({ job: job(), durationMs: 25, result: { reportId: 'r1' } })
    await flushBroadcast()

    expect(published.map(p => p.topic)).toEqual(['cf-jobs:tenant:t1'])
    expect(JSON.parse(published[0]!.data as string)).toEqual({
      channel: 'tenant:t1',
      event: 'crawl.completed',
      data: { siteId: 's1', status: 'completed' },
    })
  })

  it('supports async job channel resolvers for app-defined scopes', async () => {
    const { env, published } = createBroadcastEnv()
    const hooks = createCfJobsBroadcastRepositoryHooks(env, {
      async jobChannels({ job }) {
        await Promise.resolve()
        return [cfJobChannel(job.id), `queue-lane:${job.queue}`]
      },
    })

    hooks.onJobFailed!({ job: job(), error: 'boom' })
    await flushBroadcast()

    expect(published.map(p => p.topic).sort()).toEqual([
      'cf-jobs:job:j1',
      'cf-jobs:queue-lane:crawl',
    ])
  })

  it('publishes batch progress to the batch channel by default', async () => {
    const { env, published } = createBroadcastEnv()
    const onProgress = createCfJobsBroadcastBatchProgressHandler(env)

    onProgress({ batchId: 'b1', name: 'crawl', siteId: 's1', completed: 2, total: 3, failed: 1, finishedAt: null })
    await flushBroadcast()

    expect(published.map(p => p.topic).sort()).toEqual([
      'cf-jobs:batch:b1',
    ])
    const envelope = JSON.parse(published[0]!.data as string)
    expect(envelope.event).toBe('batch.progress')
    expect(envelope.data).toMatchObject({ batchId: 'b1', completed: 2, total: 3, failed: 1 })
  })

  it('supports async batch channel resolvers for app-defined scopes', async () => {
    const { env, published } = createBroadcastEnv()
    const onProgress = createCfJobsBroadcastBatchProgressHandler(env, {
      async batchChannels({ progress }) {
        await Promise.resolve()
        return [cfJobBatchChannel(progress.batchId), `tenant:${progress.siteId}`]
      },
    })

    onProgress({ batchId: 'b1', name: 'crawl', siteId: 's1', completed: 2, total: 3, failed: 1, finishedAt: null })
    await flushBroadcast()

    expect(published.map(p => p.topic).sort()).toEqual([
      'cf-jobs:batch:b1',
      'cf-jobs:tenant:s1',
    ])
  })
})
