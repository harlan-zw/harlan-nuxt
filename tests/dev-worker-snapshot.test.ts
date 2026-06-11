import type { D1DatabaseLike, D1PreparedStatementLike } from '#cf-jobs/server'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  claimDurableJob,
  completeDurableJob,
  createD1DurableJobRepository,
  failDurableJob,
  prepareDurableJob,
} from '#cf-jobs/server'
import { recentTerminalJobs, snapshotDurableQueues } from '../src/runtime/server/dev-worker-snapshot'

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

type Repo = ReturnType<typeof createD1DurableJobRepository>

async function seed(repo: Repo, queue: string, jobType: string): Promise<string> {
  const rec = await prepareDurableJob({ name: jobType, payload: { jobType }, route: { queue, jobType } })
  await repo.insertJob(rec)
  return rec.id
}

async function complete(repo: Repo, id: string, durationMs: number): Promise<void> {
  const claimed = await claimDurableJob(repo, id)
  if (claimed.status !== 'claimed')
    throw new Error('expected claim')
  await completeDurableJob(repo, claimed.job, { durationMs })
}

async function fail(repo: Repo, id: string, error: string): Promise<void> {
  const claimed = await claimDurableJob(repo, id)
  if (claimed.status !== 'claimed')
    throw new Error('expected claim')
  await failDurableJob(repo, claimed.job, error)
}

describe('snapshotDurableQueues', () => {
  it('splits per queue into ready / reserved / delayed / completed / failed', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()

    await complete(repo, await seed(repo, 'alpha', 'a'), 120)
    await fail(repo, await seed(repo, 'alpha', 'a'), 'boom')
    await seed(repo, 'alpha', 'a') // ready
    const reservedId = await seed(repo, 'beta', 'b')
    await claimDurableJob(repo, reservedId) // claimed but not settled → reserved

    const snap = await snapshotDurableQueues(d1)
    const alpha = snap.find(q => q.queue === 'alpha')!
    const beta = snap.find(q => q.queue === 'beta')!

    expect(alpha).toMatchObject({ ready: 1, reserved: 0, completed: 1, failed: 1 })
    expect(beta).toMatchObject({ ready: 0, reserved: 1, completed: 0, failed: 0 })
    // Sorted by queue name.
    expect(snap.map(q => q.queue)).toEqual(['alpha', 'beta'])
  })

  it('counts a delayed (future available_at) job separately from ready', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    const id = await seed(repo, 'q', 't')
    const future = Math.floor(Date.now() / 1000) + 3600
    d1._db.prepare('UPDATE jobs SET available_at = ? WHERE id = ?').run(future, id)

    const snap = await snapshotDurableQueues(d1)
    expect(snap[0]).toMatchObject({ queue: 'q', ready: 0, delayed: 1 })
  })

  it('returns an empty array when there are no jobs', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    expect(await snapshotDurableQueues(d1)).toEqual([])
  })
})

describe('recentTerminalJobs', () => {
  it('lists completed + failed jobs newest first with outcome detail', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()

    const okId = await seed(repo, 'q', 'ok-job')
    await complete(repo, okId, 142)
    const badId = await seed(repo, 'q', 'bad-job')
    await fail(repo, badId, 'kaboom\nstack line')

    const recent = await recentTerminalJobs(d1, 10)
    expect(recent).toHaveLength(2)

    const ok = recent.find(r => r.id === okId)!
    const bad = recent.find(r => r.id === badId)!
    expect(ok).toMatchObject({ type: 'ok-job', queue: 'q', outcome: 'completed', durationMs: 142, error: null })
    expect(bad).toMatchObject({ type: 'bad-job', outcome: 'failed' })
    expect(bad.error).toContain('kaboom')
  })

  it('honours the limit', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    for (let i = 0; i < 5; i++)
      await complete(repo, await seed(repo, 'q', `t${i}`), 10)

    expect(await recentTerminalJobs(d1, 3)).toHaveLength(3)
  })
})
