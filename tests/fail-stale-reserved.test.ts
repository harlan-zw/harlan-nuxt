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

async function seedStaleJob(
  d1: ReturnType<typeof createSqliteD1>,
  repo: ReturnType<typeof createD1DurableJobRepository>,
  opts: { reservedAt: number, attempts: number, maxAttempts: number },
): Promise<string> {
  const rec = await prepareDurableJob({ name: 'x', payload: {}, route: { queue: 'q', jobType: 'x' } })
  await repo.insertJob(rec)
  d1._db
    .prepare('UPDATE jobs SET reserved_at = ?, attempts = ?, max_attempts = ? WHERE id = ?')
    .run(opts.reservedAt, opts.attempts, opts.maxAttempts, rec.id)
  return rec.id
}

function countJobs(d1: ReturnType<typeof createSqliteD1>, table: 'jobs' | 'failed_jobs'): number {
  return Number((d1._db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c)
}

describe('failStaleReservedJobs (reaper honours max_attempts)', () => {
  it('moves an exhausted stale reservation to failed_jobs and removes it from jobs', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    const now = Math.floor(Date.now() / 1000)
    const id = await seedStaleJob(d1, repo, { reservedAt: now - 600, attempts: 2, maxAttempts: 2 })

    const terminalized = await repo.failStaleReservedJobs!({ staleBefore: now - 300, limit: 100 })

    expect(terminalized).toBe(1)
    expect(countJobs(d1, 'jobs')).toBe(0)
    const failed = d1._db.prepare('SELECT id, exception FROM failed_jobs WHERE id = ?').get(id) as { id: string, exception: string }
    expect(failed.id).toBe(id)
    expect(failed.exception).toBe('stale-reservation: exhausted retries')
  })

  it('leaves a still-retriable stale reservation (attempts < max) untouched', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    const now = Math.floor(Date.now() / 1000)
    await seedStaleJob(d1, repo, { reservedAt: now - 600, attempts: 1, maxAttempts: 2 })

    const terminalized = await repo.failStaleReservedJobs!({ staleBefore: now - 300, limit: 100 })

    expect(terminalized).toBe(0)
    expect(countJobs(d1, 'jobs')).toBe(1)
    expect(countJobs(d1, 'failed_jobs')).toBe(0)
  })
})

describe('releaseStaleReservedJobs no longer revives exhausted jobs', () => {
  it('does NOT release a stale job at/over max_attempts (so the reaper loop stops)', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    const now = Math.floor(Date.now() / 1000)
    const id = await seedStaleJob(d1, repo, { reservedAt: now - 600, attempts: 5, maxAttempts: 2 })

    const released = await repo.releaseStaleReservedJobs!({ staleBefore: now - 300, availableAt: now, limit: 100 })

    expect(released).toBe(0)
    // still reserved (not revived) — the reaper's failStaleReservedJobs pass owns terminalizing it
    const row = d1._db.prepare('SELECT reserved_at FROM jobs WHERE id = ?').get(id) as { reserved_at: number | null }
    expect(row.reserved_at).not.toBeNull()
  })

  it('still releases a retriable stale job (attempts < max)', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    const now = Math.floor(Date.now() / 1000)
    const id = await seedStaleJob(d1, repo, { reservedAt: now - 600, attempts: 1, maxAttempts: 2 })

    const released = await repo.releaseStaleReservedJobs!({ staleBefore: now - 300, availableAt: now, limit: 100 })

    expect(released).toBe(1)
    const row = d1._db.prepare('SELECT reserved_at FROM jobs WHERE id = ?').get(id) as { reserved_at: number | null }
    expect(row.reserved_at).toBeNull()
  })
})
