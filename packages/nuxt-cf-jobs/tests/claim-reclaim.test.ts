import type { D1DatabaseLike, D1PreparedStatementLike } from '#cf-jobs/server'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  createD1DurableJobRepository,
  prepareDurableJob,
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

async function seedReservedJob(d1: ReturnType<typeof createSqliteD1>, repo: ReturnType<typeof createD1DurableJobRepository>, reservedAt: number) {
  const rec = await prepareDurableJob({ name: 'x', payload: {}, route: { queue: 'q', jobType: 'x' } })
  await repo.insertJob(rec)
  d1._db.prepare('UPDATE jobs SET reserved_at = ? WHERE id = ?').run(reservedAt, rec.id)
  return rec.id
}

describe('claimJob reclaimAfterSeconds (Laravel retry_after)', () => {
  it('does NOT reclaim a reserved row when the option is unset', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    const now = Math.floor(Date.now() / 1000)
    const id = await seedReservedJob(d1, repo, now - 9999)

    expect(await repo.claimJob(id)).toBeNull()
  })

  it('reclaims a reservation older than reclaimAfterSeconds', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1, { reclaimAfterSeconds: 300 })
    await repo.migrate()
    const now = Math.floor(Date.now() / 1000)
    const id = await seedReservedJob(d1, repo, now - 600) // reserved 10m ago > 5m

    const job = await repo.claimJob(id)
    expect(job).not.toBeNull()
    expect(job!.attempts).toBe(1) // attempts incremented on (re)claim
  })

  it('does NOT reclaim a reservation still within reclaimAfterSeconds', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1, { reclaimAfterSeconds: 300 })
    await repo.migrate()
    const now = Math.floor(Date.now() / 1000)
    const id = await seedReservedJob(d1, repo, now - 60) // 1m ago < 5m → still running

    expect(await repo.claimJob(id)).toBeNull()
  })

  it('still claims an unreserved, available row with the option set', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1, { reclaimAfterSeconds: 300 })
    await repo.migrate()
    const rec = await prepareDurableJob({ name: 'x', payload: {}, route: { queue: 'q', jobType: 'x' } })
    await repo.insertJob(rec)
    expect(await repo.claimJob(rec.id)).not.toBeNull()
  })
})
