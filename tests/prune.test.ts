import type { D1DatabaseLike, D1PreparedStatementLike } from '#cf-jobs/server'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  createD1DurableBatchStore,
  createD1DurableJobRepository,
  prepareDurableJob,
  pruneDurableJobs,
} from '#cf-jobs/server'

function createSqliteD1(): D1DatabaseLike & { _db: DatabaseSync } {
  const db = new DatabaseSync(':memory:')
  return {
    _db: db,
    async exec(query: string) {
      db.exec(query)
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
          return { success: true, meta: { changes: Number(stmt.run(...(bound as never[])).changes) } }
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

async function seedJob(d1: ReturnType<typeof createSqliteD1>, repo: ReturnType<typeof createD1DurableJobRepository>) {
  const rec = await prepareDurableJob({ name: 'x', payload: {}, route: { queue: 'q', jobType: 'x' } })
  await repo.insertJob(rec)
  return rec.id
}

function setColumn(d1: ReturnType<typeof createSqliteD1>, table: string, column: string, value: number | null, id: string) {
  d1._db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(value, id)
}

function count(d1: ReturnType<typeof createSqliteD1>, table: string): number {
  return Number((d1._db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
}

const NOW = Math.floor(Date.now() / 1000)
const OLD = NOW - 100_000
const RECENT = NOW - 10

describe('pruneCompletedJobs', () => {
  it('deletes old completed jobs, preserves recent + in-flight', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()

    const oldDone = await seedJob(d1, repo)
    setColumn(d1, 'jobs', 'completed_at', OLD, oldDone)
    const recentDone = await seedJob(d1, repo)
    setColumn(d1, 'jobs', 'completed_at', RECENT, recentDone)
    await seedJob(d1, repo) // in-flight: completed_at IS NULL

    const deleted = await repo.pruneCompletedJobs({ before: NOW - 1000 })
    expect(deleted).toBe(1)
    expect(count(d1, 'jobs')).toBe(2) // recent + in-flight survive
  })

  it('preserves completed member evidence while the parent batch is unfinished', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    const store = createD1DurableBatchStore(d1)

    await store.insertBatch({ id: 'b-unfinished', totalJobs: 1, pendingJobs: 1 })
    const member = await seedJob(d1, repo)
    d1._db.prepare('UPDATE jobs SET batch_id = ?, completed_at = ? WHERE id = ?').run('b-unfinished', OLD, member)

    await expect(repo.pruneCompletedJobs({ before: NOW - 1000 })).resolves.toBe(0)
    expect(count(d1, 'jobs')).toBe(1)

    setColumn(d1, 'job_batches', 'finished_at', OLD, 'b-unfinished')
    await expect(repo.pruneCompletedJobs({ before: NOW - 1000 })).resolves.toBe(1)
    expect(count(d1, 'jobs')).toBe(0)
  })
})

describe('pruneFailedJobs', () => {
  it('deletes old failed jobs, preserves recent', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()

    await repo.recordFailure({ id: 'f-old', queue: 'q', jobType: 'x', payload: '{}', exception: 'boom', attempts: 3 })
    setColumn(d1, 'failed_jobs', 'failed_at', OLD, 'f-old')
    await repo.recordFailure({ id: 'f-new', queue: 'q', jobType: 'x', payload: '{}', exception: 'boom', attempts: 3 })
    setColumn(d1, 'failed_jobs', 'failed_at', RECENT, 'f-new')

    const deleted = await repo.pruneFailedJobs({ before: NOW - 1000 })
    expect(deleted).toBe(1)
    expect(count(d1, 'failed_jobs')).toBe(1)
  })

  it('preserves failed member evidence while the parent batch is unfinished', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    const store = createD1DurableBatchStore(d1)

    await store.insertBatch({ id: 'b-unfinished', totalJobs: 1, pendingJobs: 1 })
    await repo.recordFailure({ id: 'f-member', queue: 'q', jobType: 'x', batchId: 'b-unfinished', payload: '{}', exception: 'boom', attempts: 3 })
    setColumn(d1, 'failed_jobs', 'failed_at', OLD, 'f-member')

    await expect(repo.pruneFailedJobs({ before: NOW - 1000 })).resolves.toBe(0)
    expect(count(d1, 'failed_jobs')).toBe(1)

    setColumn(d1, 'job_batches', 'finished_at', OLD, 'b-unfinished')
    await expect(repo.pruneFailedJobs({ before: NOW - 1000 })).resolves.toBe(1)
    expect(count(d1, 'failed_jobs')).toBe(0)
  })
})

describe('pruneFinishedBatches', () => {
  it('deletes old finished batches, preserves in-flight + recent', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    const store = createD1DurableBatchStore(d1)

    await store.insertBatch({ id: 'b-old', totalJobs: 1, pendingJobs: 0 })
    setColumn(d1, 'job_batches', 'finished_at', OLD, 'b-old')
    await store.insertBatch({ id: 'b-recent', totalJobs: 1, pendingJobs: 0 })
    setColumn(d1, 'job_batches', 'finished_at', RECENT, 'b-recent')
    await store.insertBatch({ id: 'b-inflight', totalJobs: 2, pendingJobs: 1 }) // finished_at IS NULL

    const deleted = await repo.pruneFinishedBatches({ before: NOW - 1000 })
    expect(deleted).toBe(1)
    expect(count(d1, 'job_batches')).toBe(2)
  })

  it('preserves finished child batch evidence while the parent batch is unfinished', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    const store = createD1DurableBatchStore(d1)

    await store.insertBatch({ id: 'parent', totalJobs: 1, pendingJobs: 1 })
    await store.insertBatch({ id: 'child', parentBatchId: 'parent', totalJobs: 1, pendingJobs: 0 })
    setColumn(d1, 'job_batches', 'finished_at', OLD, 'child')

    await expect(repo.pruneFinishedBatches({ before: NOW - 1000 })).resolves.toBe(0)
    expect(count(d1, 'job_batches')).toBe(2)

    setColumn(d1, 'job_batches', 'finished_at', OLD, 'parent')
    await expect(repo.pruneFinishedBatches({ before: NOW - 1000 })).resolves.toBe(2)
    expect(count(d1, 'job_batches')).toBe(0)
  })
})

describe('pruneInChunks loop', () => {
  it('removes the full backlog when it exceeds the chunk limit', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()

    for (let i = 0; i < 25; i++) {
      const id = await seedJob(d1, repo)
      setColumn(d1, 'jobs', 'completed_at', OLD, id)
    }

    const deleted = await repo.pruneCompletedJobs({ before: NOW - 1000, limit: 10 })
    expect(deleted).toBe(25)
    expect(count(d1, 'jobs')).toBe(0)
  })
})

describe('pruneDurableJobs convenience', () => {
  it('prunes member jobs before batches without violating the FK (foreign_keys ON)', async () => {
    const d1 = createSqliteD1()
    await d1.exec('PRAGMA foreign_keys = ON')
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    const store = createD1DurableBatchStore(d1)

    // Finished batch with one completed member job pointing at it (jobs.batch_id FK).
    await store.insertBatch({ id: 'b1', totalJobs: 1, pendingJobs: 0 })
    setColumn(d1, 'job_batches', 'finished_at', OLD, 'b1')
    const member = await seedJob(d1, repo)
    d1._db.prepare('UPDATE jobs SET batch_id = ?, completed_at = ? WHERE id = ?').run('b1', OLD, member)
    await repo.recordFailure({ id: 'f1', queue: 'q', jobType: 'x', batchId: 'b1', payload: '{}', exception: 'boom', attempts: 3 })
    setColumn(d1, 'failed_jobs', 'failed_at', OLD, 'f1')

    const result = await pruneDurableJobs(repo, {
      completedBefore: NOW - 1000,
      failedBefore: NOW - 1000,
      finishedBatchesBefore: NOW - 1000,
    })

    expect(result).toEqual({ completedJobs: 1, failedJobs: 1, finishedBatches: 1 })
    expect(count(d1, 'jobs')).toBe(0)
    expect(count(d1, 'failed_jobs')).toBe(0)
    expect(count(d1, 'job_batches')).toBe(0)
  })

  it('skips a table whose cutoff is undefined', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    const id = await seedJob(d1, repo)
    setColumn(d1, 'jobs', 'completed_at', OLD, id)

    const result = await pruneDurableJobs(repo, { failedBefore: NOW })
    expect(result).toEqual({ completedJobs: 0, failedJobs: 0, finishedBatches: 0 })
    expect(count(d1, 'jobs')).toBe(1) // completed job untouched (no completedBefore)
  })
})
