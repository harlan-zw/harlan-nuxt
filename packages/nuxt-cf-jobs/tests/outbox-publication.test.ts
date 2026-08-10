import type { D1DatabaseLike, D1PreparedStatementLike, DurableJobRecord } from '#cf-jobs/server'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import {
  createD1DurableJobRepository,
  createDurableJobsRuntime,
  defineJob,
  defineJobRegistry,
  enqueueDurableJob,
  prepareDurableJob,
  publishDurableJobBatch,
  recoverDurableJobs,
  stagePreparedDurableJobs,
  sweepDispatchableDurableJobs,
} from '#cf-jobs/server'
import { createFakeQueueEnv, createQueueMessage } from '#cf-jobs/testing'

function createSqliteD1(): D1DatabaseLike & { _db: DatabaseSync } {
  const db = new DatabaseSync(':memory:')
  return {
    _db: db,
    async exec(query: string) {
      db.exec(query)
    },
    async batch(statements) {
      db.exec('BEGIN')
      const results: Array<{ success?: boolean, meta?: { changes?: number } }> = []
      try {
        for (const statement of statements)
          results.push(await statement.run())
        db.exec('COMMIT')
        return results
      }
      catch (cause) {
        db.exec('ROLLBACK')
        throw cause
      }
    },
    prepare<T = unknown>(query: string): D1PreparedStatementLike<T> {
      const stmt = db.prepare(query)
      let bound: unknown[] = []
      const api: D1PreparedStatementLike<T> = {
        bind(...values: unknown[]) {
          bound = values
          return api
        },
        async run() {
          const result = stmt.run(...(bound as never[]))
          return { success: true, meta: { changes: Number(result.changes) } }
        },
        async first<Result = T>() {
          return (stmt.get(...(bound as never[])) ?? null) as Result | null
        },
        async all<Result = T>() {
          return { results: stmt.all(...(bound as never[])) as Result[] }
        },
      }
      return api
    },
  }
}

async function record(id: string): Promise<DurableJobRecord> {
  return await prepareDurableJob({
    id,
    name: 'events/deliver-listener',
    payload: { listener: id },
    route: { queue: 'events', jobType: `event-listener/${id}` },
    now: 100,
    traceId: `event_${id}`,
  })
}

describe('transactional durable staging', () => {
  it('keeps legacy inserts claimable while explicit stages wait for publication', async () => {
    const db = createSqliteD1()
    const repository = createD1DurableJobRepository(db)
    await repository.migrate()
    const legacy = await record('legacy-claimable')
    const staged = await record('staged-waits')
    await repository.insertJob(legacy)
    expect((await stagePreparedDurableJobs(repository, [staged])).status).toBe('staged')

    await expect(repository.claimJob(legacy.id)).resolves.toMatchObject({ id: legacy.id })
    await expect(repository.claimJob(staged.id)).resolves.toBeNull()
    await publishDurableJobBatch(repository, { sendBatch: async () => true }, [staged], { now: 100 })
    await expect(repository.claimJob(staged.id)).resolves.toMatchObject({ id: staged.id })
  })

  it('returns strict statements for a caller-owned D1 batch', async () => {
    const db = createSqliteD1()
    const repository = createD1DurableJobRepository(db)
    await repository.migrate()
    const records = await Promise.all([record('a'), record('b')])

    const prepared = repository.prepareStageJobs(records)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok)
      throw new Error('unexpected invalid stage')

    const domain = db.prepare('CREATE TABLE domain_commit (id text PRIMARY KEY)').bind()
    await db.batch!([domain, ...prepared.value.statements])

    expect(db._db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 2 })
  })

  it('rolls back the whole stage on one conflict', async () => {
    const db = createSqliteD1()
    const repository = createD1DurableJobRepository(db)
    await repository.migrate()
    const a = await record('same')
    const b = await record('other')
    expect((await stagePreparedDurableJobs(repository, [a])).status).toBe('staged')

    const result = await stagePreparedDurableJobs(repository, [b, a])

    expect(result.status).toBe('failed')
    expect(db._db.prepare('SELECT id FROM jobs ORDER BY id').all()).toEqual([{ id: 'same' }])
  })
})

describe('durable publication state', () => {
  it('uses legacy insertion unless every publication primitive is present', async () => {
    const job = await record('partial-publication-repository')
    const repository = {
      insertJob: vi.fn(async () => true),
      stageJob: vi.fn(async () => true),
    }

    const result = await enqueueDurableJob(repository, { send: async () => true }, job)

    expect(result).toEqual({ status: 'enqueued' })
    expect(repository.insertJob).toHaveBeenCalledWith(job)
    expect(repository.stageJob).not.toHaveBeenCalled()
  })

  it('upgrades old jobs as already published without replaying the backlog', async () => {
    const db = createSqliteD1()
    db._db.exec(`
      CREATE TABLE jobs (
        id text PRIMARY KEY, queue text NOT NULL, job_type text NOT NULL, batch_id text,
        user_id integer, site_id text, partner_id text, trace_id text, unique_key text,
        payload text NOT NULL, attempts integer DEFAULT 0, max_attempts integer DEFAULT 3,
        reserved_at integer, available_at integer NOT NULL, created_at integer NOT NULL,
        completed_at integer, failed_at integer, last_error text, retry_reasons text,
        rows_fetched integer, rows_inserted integer, d1_rows_read integer,
        d1_rows_written integer, duration_ms integer
      );
      INSERT INTO jobs (id, queue, job_type, payload, available_at, created_at)
      VALUES ('legacy', 'events', 'legacy', '{}', 50, 40);
    `)
    const repository = createD1DurableJobRepository(db)

    await repository.migrate()

    expect(db._db.prepare('SELECT published_at, last_dispatched_at, dispatch_attempts FROM jobs WHERE id = ?').get('legacy')).toEqual({
      published_at: 40,
      last_dispatched_at: 40,
      dispatch_attempts: 1,
    })
    await expect(repository.findDispatchableJobs({ now: 100 })).resolves.toEqual([])
  })

  it('resumes a partially applied publication upgrade', async () => {
    const db = createSqliteD1()
    db._db.exec(`
      CREATE TABLE jobs (
        id text PRIMARY KEY, queue text NOT NULL, job_type text NOT NULL, batch_id text,
        user_id integer, site_id text, partner_id text, trace_id text, unique_key text,
        payload text NOT NULL, attempts integer DEFAULT 0, max_attempts integer DEFAULT 3,
        reserved_at integer, available_at integer NOT NULL, created_at integer NOT NULL,
        published_at integer, completed_at integer, failed_at integer, last_error text,
        retry_reasons text, rows_fetched integer, rows_inserted integer,
        d1_rows_read integer, d1_rows_written integer, duration_ms integer
      );
      INSERT INTO jobs (id, queue, job_type, payload, available_at, created_at)
      VALUES ('partial-legacy', 'events', 'legacy', '{}', 50, 40);
    `)
    const repository = createD1DurableJobRepository(db)

    await repository.migrate()
    const inserted = await repository.insertJob(await record('after-resume'))

    expect(inserted).toBe(true)
    const columns = db._db.prepare('PRAGMA table_info(jobs)').all().map(row => (row as { name: string }).name)
    expect(columns).toEqual(expect.arrayContaining([
      'backoff',
      'published_at',
      'last_dispatched_at',
      'dispatch_attempts',
      'last_dispatch_error',
    ]))
    expect(db._db.prepare('SELECT published_at FROM jobs WHERE id = ?').get('partial-legacy')).toEqual({ published_at: null })
  })

  it('marks only successfully sent rows as published', async () => {
    const db = createSqliteD1()
    const repository = createD1DurableJobRepository(db)
    await repository.migrate()
    const records = await Promise.all([record('a'), record('b')])
    expect((await stagePreparedDurableJobs(repository, records)).status).toBe('staged')
    const publisher = { sendBatch: vi.fn(async () => true) }

    const result = await publishDurableJobBatch(repository, publisher, records, { now: 200 })

    expect(result).toEqual([{ queue: 'events', status: 'published', jobIds: ['a', 'b'] }])
    expect(db._db.prepare('SELECT id, published_at, last_dispatched_at, dispatch_attempts, last_dispatch_error FROM jobs ORDER BY id').all()).toEqual([
      { id: 'a', published_at: 200, last_dispatched_at: 200, dispatch_attempts: 1, last_dispatch_error: null },
      { id: 'b', published_at: 200, last_dispatched_at: 200, dispatch_attempts: 1, last_dispatch_error: null },
    ])
  })

  it('keeps failed sends unpublished and recoverable with durable evidence', async () => {
    const db = createSqliteD1()
    const repository = createD1DurableJobRepository(db)
    await repository.migrate()
    const job = await record('lost')
    expect((await stagePreparedDurableJobs(repository, [job])).status).toBe('staged')
    const publisher = { sendBatch: vi.fn(async () => {
      throw new Error('queue unavailable')
    }) }

    const result = await publishDurableJobBatch(repository, publisher, [job], { now: 201 })
    const recoverable = await repository.findDispatchableJobs({ now: 201 })

    expect(result[0]).toMatchObject({ queue: 'events', status: 'failed', jobIds: ['lost'] })
    expect(recoverable.map(row => row.id)).toEqual(['lost'])
    expect(db._db.prepare('SELECT published_at, dispatch_attempts, last_dispatch_error FROM jobs WHERE id = ?').get('lost')).toEqual({
      published_at: null,
      dispatch_attempts: 1,
      last_dispatch_error: 'queue unavailable',
    })
  })

  it('marks rows published when the public sweep sends them', async () => {
    const db = createSqliteD1()
    const repository = createD1DurableJobRepository(db)
    await repository.migrate()
    const job = await record('swept')
    expect((await stagePreparedDurableJobs(repository, [job])).status).toBe('staged')

    const result = await sweepDispatchableDurableJobs(repository, { sendBatch: async () => true }, { now: 100 })

    expect(result).toEqual({ swept: 1, dispatched: [{ queue: 'events', status: 'sent' }] })
    expect(db._db.prepare('SELECT published_at FROM jobs WHERE id = ?').get(job.id)).toEqual({ published_at: 100 })
    await expect(repository.claimJob(job.id)).resolves.toMatchObject({ id: job.id })
  })

  it('re-publishes a stale claim after the redelivery grace window', async () => {
    const db = createSqliteD1()
    const repository = createD1DurableJobRepository(db)
    await repository.migrate()
    const job = await record('worker-terminated')
    expect((await stagePreparedDurableJobs(repository, [job])).status).toBe('staged')
    await publishDurableJobBatch(repository, { sendBatch: async () => true }, [job], { now: 100 })
    await expect(repository.claimJob(job.id)).resolves.toMatchObject({ id: job.id })
    db._db.prepare('UPDATE jobs SET reserved_at = 100 WHERE id = ?').run(job.id)
    const publisher = { sendBatch: vi.fn(async () => true) }

    const grace = await recoverDurableJobs(repository, publisher, {
      now: 1_000,
      staleSeconds: 300,
      orphanedSeconds: 0,
      redeliveryGraceSeconds: 120,
    })
    const recovered = await recoverDurableJobs(repository, publisher, {
      now: 1_121,
      staleSeconds: 300,
      orphanedSeconds: 0,
      redeliveryGraceSeconds: 120,
    })

    expect(grace).toMatchObject({ released: 1, dispatched: 0 })
    expect(db._db.prepare('SELECT published_at FROM jobs WHERE id = ?').get(job.id)).toEqual({ published_at: 100 })
    expect(recovered).toMatchObject({ released: 0, dispatched: 1 })
    expect(publisher.sendBatch).toHaveBeenCalledTimes(1)
    await expect(repository.claimJob(job.id)).resolves.toMatchObject({ id: job.id })
  })

  it('never selects already-published backlog rows for recovery', async () => {
    const db = createSqliteD1()
    const repository = createD1DurableJobRepository(db)
    await repository.migrate()
    const job = await record('sent')
    expect((await stagePreparedDurableJobs(repository, [job])).status).toBe('staged')
    await publishDurableJobBatch(repository, { sendBatch: async () => true }, [job], { now: 202 })

    await expect(repository.findDispatchableJobs({ now: 9_999 })).resolves.toEqual([])
  })
})

describe('per-record retry policy', () => {
  it('retries with the stored delay for the current attempt', async () => {
    const db = createSqliteD1()
    const fake = createFakeQueueEnv<{ jobId: string, queue: 'events' }>('EVENTS')
    const definition = defineJob({
      name: 'events/deliver-listener',
      queue: 'events',
      tries: 3,
      backoff: [7, 30, 90],
      async handle() {
        throw new Error('listener failed')
      },
    })
    const registry = defineJobRegistry([definition])
    const runtime = createDurableJobsRuntime({
      db,
      env: fake.env,
      registry,
      resolveQueueBinding: () => 'EVENTS',
      createJobContext: ({ job }) => ({
        env: {},
        db: {},
        log: {},
        jobId: job.id,
        batchId: job.batchId,
        attempt: job.attempts,
        release: async () => {},
        fail: async () => {},
      }),
    })
    await runtime.repository.migrate()
    const prepared = await prepareDurableJob({
      id: 'backoff-job',
      name: definition.name,
      payload: {},
      definition,
      route: { queue: 'events', jobType: definition.name },
      now: 100,
    })
    await runtime.enqueue(prepared)
    const message = createQueueMessage({ jobId: prepared.id, queue: 'events' as const })

    const result = await runtime.consumeMessage(message)

    expect(result.run.status).toBe('errored')
    expect(message.retries).toEqual([{ delaySeconds: 7 }])
    expect(db._db.prepare('SELECT backoff, attempts FROM jobs WHERE id = ?').get(prepared.id)).toEqual({
      backoff: '[7,30,90]',
      attempts: 1,
    })
  })

  it('runs the definition failed callback only after stored attempts are exhausted', async () => {
    const db = createSqliteD1()
    const fake = createFakeQueueEnv<{ jobId: string, queue: 'events' }>('EVENTS')
    const failed = vi.fn(async () => {})
    const definition = defineJob({
      name: 'events/terminal-listener',
      queue: 'events',
      tries: 2,
      backoff: [0, 0],
      async handle() {
        throw new Error('terminal listener failed')
      },
      failed,
    })
    const registry = defineJobRegistry([definition])
    const runtime = createDurableJobsRuntime({
      db,
      env: fake.env,
      registry,
      resolveQueueBinding: () => 'EVENTS',
      createJobContext: ({ job }) => ({
        env: {},
        db: {},
        log: {},
        jobId: job.id,
        batchId: job.batchId,
        attempt: job.attempts,
        release: async () => {},
        fail: async () => {},
      }),
    })
    await runtime.repository.migrate()
    const prepared = await prepareDurableJob({
      id: 'terminal-job',
      name: definition.name,
      payload: {},
      definition,
      route: { queue: 'events', jobType: definition.name },
      now: Math.floor(Date.now() / 1000),
    })
    await runtime.enqueue(prepared)

    const first = await runtime.consumeMessage(createQueueMessage({ jobId: prepared.id, queue: 'events' as const }))
    expect(first.run.status).toBe('errored')
    expect(failed).not.toHaveBeenCalled()

    const second = await runtime.consumeMessage(createQueueMessage({ jobId: prepared.id, queue: 'events' as const }))
    expect(second.run.status).toBe('exhausted')
    expect(failed).toHaveBeenCalledOnce()
    expect(failed.mock.calls[0]?.[2]).toMatchObject({ message: 'terminal listener failed' })
  })
})
