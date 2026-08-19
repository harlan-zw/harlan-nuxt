import type { D1DatabaseLike, D1PreparedStatementLike } from '#cf-jobs/server'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createD1DurableJobRepository, prepareDurableJob } from '#cf-jobs/server'
import { resolveReconcileOptions } from '../src/module'

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

async function seedStagedJob(repo: ReturnType<typeof createD1DurableJobRepository>, createdAt: number): Promise<string> {
  const record = await prepareDurableJob({ name: 'x', payload: {}, route: { queue: 'q', jobType: 'x' } })
  await repo.stageJob({ ...record, createdAt, availableAt: createdAt })
  return record.id
}

const NOW = 2_000_000

describe('orphan sweep damping', () => {
  it('excludes a row dispatched inside the window even when its evidence log overflowed', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    const id = await seedStagedJob(repo, NOW - 100_000)
    await repo.markJobsPublished([id], { at: NOW - 60 })
    // A busy row keeps writing release evidence. The evidence log is bounded, so
    // any orphan-redispatch marker in it is evicted; the damping must not be.
    for (let i = 0; i < 12; i++) {
      d1._db.prepare(`UPDATE jobs SET retry_reasons = json_insert(COALESCE(retry_reasons, '[]'), '$[#]', json(?)) WHERE id = ?`)
        .run(JSON.stringify({ _tag: 'release', at: NOW - 30, description: 'noise' }), id)
    }

    const dispatchable = await repo.findDispatchableJobs({
      now: NOW,
      createdBefore: NOW - 600,
      redispatchedBefore: NOW - 600,
      publication: 'all',
      limit: 10,
    })

    expect(dispatchable.map(job => job.id)).toEqual([])
  })

  it('includes a row whose last dispatch is older than the window', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    const id = await seedStagedJob(repo, NOW - 100_000)
    await repo.markJobsPublished([id], { at: NOW - 5_000 })

    const dispatchable = await repo.findDispatchableJobs({
      now: NOW,
      createdBefore: NOW - 600,
      redispatchedBefore: NOW - 600,
      publication: 'all',
      limit: 10,
    })

    expect(dispatchable.map(job => job.id)).toEqual([id])
  })

  it('keeps a row whose last dispatch FAILED eligible on the next tick', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    const id = await seedStagedJob(repo, NOW - 100_000)
    await repo.noteJobsDispatchFailure([id], new Error('queue binding unavailable'), { at: NOW - 60 })

    const dispatchable = await repo.findDispatchableJobs({
      now: NOW,
      createdBefore: NOW - 600,
      redispatchedBefore: NOW - 600,
      publication: 'all',
      limit: 10,
    })

    expect(dispatchable.map(job => job.id)).toEqual([id])
  })

  it('records a sweep re-dispatch on the durable columns, not only in the evidence log', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    const id = await seedStagedJob(repo, NOW - 100_000)

    expect(await repo.noteOrphanRedispatch([id], { at: NOW })).toBe(1)

    const row = d1._db.prepare('SELECT last_dispatched_at, dispatch_attempts FROM jobs WHERE id = ?').get(id) as {
      last_dispatched_at: number
      dispatch_attempts: number
    }
    expect(row).toEqual({ last_dispatched_at: NOW, dispatch_attempts: 1 })
    await expect(repo.findDispatchableJobs({
      now: NOW,
      createdBefore: NOW - 600,
      redispatchedBefore: NOW - 600,
      publication: 'all',
      limit: 10,
    })).resolves.toEqual([])
  })

  it('stamps the legacy immediate insert as dispatched so it is not swept at once', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    const record = await prepareDurableJob({ name: 'x', payload: {}, route: { queue: 'q', jobType: 'x' } })
    await repo.insertJob({ ...record, createdAt: NOW - 60, availableAt: NOW - 60 })

    await expect(repo.findDispatchableJobs({
      now: NOW,
      createdBefore: NOW,
      redispatchedBefore: NOW - 600,
      publication: 'all',
      limit: 10,
    })).resolves.toEqual([])
  })
})

describe('resolveReconcileOptions defaults', () => {
  it('keeps the orphan window above a realistic queue wait and damps per row', () => {
    expect(resolveReconcileOptions(true)).toMatchObject({
      staleSeconds: 900,
      orphanedSeconds: 6 * 60 * 60,
      redispatchGraceSeconds: 6 * 60 * 60,
      limit: 100,
    })
  })

  it('derives the redispatch grace from a custom orphan window', () => {
    expect(resolveReconcileOptions({ orphanedSeconds: 1_800 })).toMatchObject({
      orphanedSeconds: 1_800,
      redispatchGraceSeconds: 1_800,
    })
  })

  it('lets an app set the two windows independently', () => {
    expect(resolveReconcileOptions({ orphanedSeconds: 1_800, redispatchGraceSeconds: 60 })).toMatchObject({
      orphanedSeconds: 1_800,
      redispatchGraceSeconds: 60,
    })
  })
})
