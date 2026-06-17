import type { D1DatabaseLike, D1PreparedStatementLike } from '#cf-jobs/server'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  createD1DurableBatchStore,
  createD1DurableJobRepository,
  getDurableJobStatus,
  listD1BatchMembers,
  prepareDurableJob,
  resolveDurableBatchMemberState,
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

async function seedJob(
  repo: ReturnType<typeof createD1DurableJobRepository>,
  name: string,
  batchId: string,
) {
  const rec = await prepareDurableJob({ name, payload: {}, route: { queue: 'q', jobType: name }, batchId })
  await repo.insertJob(rec)
  return rec.id
}

describe('durable job inspection helpers', () => {
  it('derives active job status from durable row timestamps', () => {
    const now = 1_000
    expect(getDurableJobStatus({ failed_at: 900, available_at: 0 }, now)).toBe('failed')
    expect(getDurableJobStatus({ completedAt: 900, availableAt: 0 }, now)).toBe('completed')
    expect(getDurableJobStatus({ reserved_at: 900, available_at: 0 }, now)).toBe('running')
    expect(getDurableJobStatus({ available_at: 1_100 }, now)).toBe('scheduled')
    expect(getDurableJobStatus({ availableAt: 900 }, now)).toBe('queued')
  })

  it('derives batch member state from active job timestamps', () => {
    expect(resolveDurableBatchMemberState({ completed_at: 10 })).toBe('done')
    expect(resolveDurableBatchMemberState({ reservedAt: 10 })).toBe('running')
    expect(resolveDurableBatchMemberState({})).toBe('pending')
  })

  it('lists active and failed D1 batch members with module state labels', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    const store = createD1DurableBatchStore(d1)
    await repo.migrate()
    await store.insertBatch({ id: 'b1', totalJobs: 4, pendingJobs: 4 })
    await store.insertBatch({ id: 'b2', totalJobs: 1, pendingJobs: 1 })

    const pending = await seedJob(repo, 'pending-job', 'b1')
    const running = await seedJob(repo, 'running-job', 'b1')
    const done = await seedJob(repo, 'done-job', 'b1')
    await seedJob(repo, 'other-batch-job', 'b2')
    d1._db.prepare('UPDATE jobs SET reserved_at = ? WHERE id = ?').run(900, running)
    d1._db.prepare('UPDATE jobs SET completed_at = ? WHERE id = ?').run(950, done)
    await repo.recordFailure({ id: 'failed', queue: 'q', jobType: 'failed-job', batchId: 'b1', payload: '{}', exception: 'boom', attempts: 3 })

    const members = await listD1BatchMembers(d1, 'b1')

    expect(members).toEqual([
      { id: running, jobType: 'running-job', state: 'running' },
      { id: done, jobType: 'done-job', state: 'done' },
      { id: pending, jobType: 'pending-job', state: 'pending' },
      { id: 'failed', jobType: 'failed-job', state: 'failed' },
    ])
  })
})
