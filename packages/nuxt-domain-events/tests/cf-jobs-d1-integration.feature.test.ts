import type { D1DatabaseLike, D1PreparedStatementLike } from '@harlanzw/nuxt-cf-jobs/outbox'
import type { EventCommitInput, QueuedListenerPublication } from '../src/runtime/server/types'
import { DatabaseSync } from 'node:sqlite'
import {
  createD1DurableJobRepository,
  prepareDurableJobResult,
  publishDurableJobBatch,
  stagePreparedDurableJobs,
} from '@harlanzw/nuxt-cf-jobs/outbox'
import { describe, expect, it, vi } from 'vitest'
import { createCfJobsEventQueueAdapter } from '../src/runtime/server/adapters/cf-jobs'

function createSqliteD1(): D1DatabaseLike & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:')
  return {
    sqlite,
    async exec(query: string) {
      sqlite.exec(query)
    },
    async batch(statements) {
      sqlite.exec('BEGIN')
      return await statements.reduce(
        async (pending, statement) => [...await pending, await statement.run()],
        Promise.resolve([] as Array<{ success?: boolean, meta?: { changes?: number } }>),
      )
        .then((results) => {
          sqlite.exec('COMMIT')
          return results
        })
        .catch((error: unknown) => {
          sqlite.exec('ROLLBACK')
          throw error
        })
    },
    prepare<Output = unknown>(query: string): D1PreparedStatementLike<Output> {
      const statement = sqlite.prepare(query)
      let values: unknown[] = []
      const prepared: D1PreparedStatementLike<Output> = {
        bind(...input: unknown[]) {
          values = input
          return prepared
        },
        async run() {
          const result = statement.run(...(values as never[]))
          return { success: true, meta: { changes: Number(result.changes) } }
        },
        async first<Result = Output>() {
          return (statement.get(...(values as never[])) ?? null) as Result | null
        },
        async all<Result = Output>() {
          return { results: statement.all(...(values as never[])) as Result[] }
        },
      }
      return prepared
    },
  }
}

const publication: QueuedListenerPublication = {
  deliveryId: 'event-1:listener-1',
  queue: 'notifications',
  tries: 3,
  backoff: [5, 30, 120],
  envelope: {
    _tag: 'event-listener',
    deliveryId: 'event-1:listener-1',
    eventId: 'event-1',
    eventName: 'user:created',
    eventVersion: 1,
    listenerName: 'listener-1',
    occurredAt: '2026-08-05T00:00:00.000Z',
    payload: { userId: 'user-1' },
  },
}

function createAdapter(database: D1DatabaseLike, sendBatch: (queue: string, messages: unknown[]) => Promise<boolean>) {
  const repository = createD1DurableJobRepository(database)
  const adapter = createCfJobsEventQueueAdapter({
    outbox: { prepareDurableJobResult, publishDurableJobBatch, stagePreparedDurableJobs },
    repository,
    publisher: { sendBatch },
  })
  return { adapter, repository }
}

describe('nuxt-cf-jobs D1 integration', () => {
  it('persists one routed durable job and records successful publication evidence', async () => {
    const database = createSqliteD1()
    const sendBatch = vi.fn(async () => true)
    const { adapter, repository } = createAdapter(database, sendBatch)
    await repository.migrate()

    await expect(adapter.queue.publishImmediate([publication], { observe: () => {} })).resolves.toEqual([
      { _tag: 'published', deliveryId: publication.deliveryId, queue: 'notifications' },
    ])

    expect(sendBatch).toHaveBeenCalledWith('notifications', [{ jobId: publication.deliveryId, queue: 'notifications' }], { delaySeconds: undefined })
    expect(database.sqlite.prepare('SELECT id, queue, job_type, max_attempts, backoff, published_at, dispatch_attempts FROM jobs').get()).toEqual({
      id: publication.deliveryId,
      queue: 'notifications',
      job_type: 'event-listener/listener-1',
      max_attempts: 3,
      backoff: '[5,30,120]',
      published_at: expect.any(Number),
      dispatch_attempts: 1,
    })
  })

  it('keeps a failed queue send durable, unpublished, and recoverable', async () => {
    const database = createSqliteD1()
    const { adapter, repository } = createAdapter(database, async () => {
      throw new Error('queue unavailable')
    })
    await repository.migrate()

    await expect(adapter.queue.publishImmediate([publication], { observe: () => {} })).resolves.toEqual([
      expect.objectContaining({ _tag: 'failed', deliveryId: publication.deliveryId, status: 'failed' }),
    ])

    expect(database.sqlite.prepare('SELECT published_at, dispatch_attempts, last_dispatch_error FROM jobs').get()).toEqual({
      published_at: null,
      dispatch_attempts: 1,
      last_dispatch_error: 'queue unavailable',
    })
    await expect(repository.findDispatchableJobs!()).resolves.toEqual([
      expect.objectContaining({ id: publication.deliveryId, queue: 'notifications' }),
    ])
  })

  it('stages domain and listener rows atomically before after-commit dispatch', async () => {
    const database = createSqliteD1()
    const { adapter, repository } = createAdapter(database, async () => true)
    await repository.migrate()
    database.sqlite.exec('CREATE TABLE domain_events (id text PRIMARY KEY)')
    const input: EventCommitInput = {
      planId: 'plan-1',
      eventId: publication.envelope.eventId,
      eventName: publication.envelope.eventName,
      publications: [publication],
    }
    const stage = await adapter.prepareCommitStage(input)

    await database.batch!([
      database.prepare('INSERT INTO domain_events (id) VALUES (?)').bind('domain-1'),
      ...stage.statements as D1PreparedStatementLike[],
    ])
    expect(database.sqlite.prepare('SELECT id FROM domain_events').get()).toEqual({ id: 'domain-1' })
    expect(database.sqlite.prepare('SELECT id, published_at FROM jobs').get()).toEqual({ id: publication.deliveryId, published_at: null })

    await expect(adapter.queue.dispatchCommitted([publication], { observe: () => {} })).resolves.toEqual([
      { _tag: 'published', deliveryId: publication.deliveryId, queue: 'notifications' },
    ])
  })
})
