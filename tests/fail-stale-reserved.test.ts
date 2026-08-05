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
    async batch(statements) {
      db.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements)
          results.push(await statement.run())
        db.exec('COMMIT')
        return results
      }
      catch (error) {
        db.exec('ROLLBACK')
        throw error
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
          if (/\bRETURNING\b/i.test(query)) {
            const results = stmt.all(...(bound as never[])) as T[]
            return { success: true, meta: { changes: results.length }, results }
          }
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

    const terminalized = await repo.failStaleReservedJobs!({ now, staleBefore: now - 300, limit: 100 })

    expect(terminalized).toEqual([expect.objectContaining({
      id,
      queue: 'q',
      batchId: null,
      jobType: 'x',
      payload: '{"_task":"x"}',
      attempts: 2,
      exception: expect.stringContaining('stale-reservation: exhausted retries'),
    })])
    expect(countJobs(d1, 'jobs')).toBe(0)
    const failed = d1._db.prepare('SELECT id, exception FROM failed_jobs WHERE id = ?').get(id) as { id: string, exception: string }
    expect(failed.id).toBe(id)
    expect(failed.exception).toBe(
      'stale-reservation: exhausted retries (attempts=2, reserved 600s ago; last error: none; last evidence: none, no release recorded, possible isolate termination)',
    )
  })

  it('carries the latest release and DLQ evidence into the terminal exception', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    const now = Math.floor(Date.now() / 1000)
    const id = await seedStaleJob(d1, repo, { reservedAt: now - 923, attempts: 4, maxAttempts: 4 })
    d1._db.prepare(`
      UPDATE jobs
      SET last_error = ?,
          retry_reasons = ?
      WHERE id = ?
    `).run(
      'handler timed out',
      JSON.stringify([
        { _tag: 'release', at: now - 1_000, description: `release@${now - 1_000}: handler timed out`, delaySeconds: 60, error: 'handler timed out' },
        { _tag: 'dlq-arrival', at: now - 20, description: `dlq@${now - 20}: Cloudflare retries exhausted (message attempts=5)`, messageAttempts: 5 },
      ]),
      id,
    )

    await repo.failStaleReservedJobs!({
      now,
      staleBefore: now - 300,
      error: 'stale-reservation: exhausted retries',
      limit: 100,
    })

    const failed = d1._db.prepare('SELECT exception FROM failed_jobs WHERE id = ?').get(id) as { exception: string }
    expect(failed.exception).toBe(
      `stale-reservation: exhausted retries (attempts=4, reserved 923s ago; last error: handler timed out; last evidence: dlq@${now - 20}: Cloudflare retries exhausted (message attempts=5))`,
    )
  })

  it('leaves a still-retriable stale reservation (attempts < max) untouched', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    const now = Math.floor(Date.now() / 1000)
    await seedStaleJob(d1, repo, { reservedAt: now - 600, attempts: 1, maxAttempts: 2 })

    const terminalized = await repo.failStaleReservedJobs!({ staleBefore: now - 300, limit: 100 })

    expect(terminalized).toEqual([])
    expect(countJobs(d1, 'jobs')).toBe(1)
    expect(countJobs(d1, 'failed_jobs')).toBe(0)
  })
})

describe('bounded failure evidence', () => {
  it('keeps only the eight latest release events', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    const rec = await prepareDurableJob({ name: 'x', payload: {}, route: { queue: 'q', jobType: 'x' } })
    await repo.insertJob(rec)

    for (let i = 0; i < 10; i++) {
      const claimed = await repo.claimJob(rec.id)
      await repo.releaseJob!(claimed!, { error: `failure-${i}` })
    }

    const row = d1._db.prepare('SELECT retry_reasons FROM jobs WHERE id = ?').get(rec.id) as { retry_reasons: string }
    const evidence = JSON.parse(row.retry_reasons) as Array<{ _tag: string, error: string }>
    expect(evidence).toHaveLength(8)
    expect(evidence.map(item => item.error)).toEqual([
      'failure-2',
      'failure-3',
      'failure-4',
      'failure-5',
      'failure-6',
      'failure-7',
      'failure-8',
      'failure-9',
    ])
    expect(evidence.every(item => item._tag === 'release')).toBe(true)
  })

  it('keeps a recent stale release suppressed when newer evidence is appended', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    const rec = await prepareDurableJob({ name: 'x', payload: {}, route: { queue: 'q', jobType: 'x' }, now: 1_000 })
    await repo.insertJob(rec)
    d1._db.prepare('UPDATE jobs SET retry_reasons = ? WHERE id = ?').run(JSON.stringify([
      { _tag: 'stale-release', at: 950, description: 'stale-release@950: stale-reservation' },
      { _tag: 'dlq-arrival', at: 990, description: 'dlq@990: Cloudflare retries exhausted', messageAttempts: 5 },
    ]), rec.id)

    await expect(
      repo.findDispatchableJobs({ now: 1_000, staleReleasedBefore: 880, publication: 'all' }),
    )
      .resolves
      .toEqual([])
    await expect(
      repo.findDispatchableJobs({ now: 1_000, staleReleasedBefore: 960, publication: 'all' }),
    )
      .resolves
      .toEqual([expect.objectContaining({ id: rec.id })])
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
    const row = d1._db.prepare('SELECT reserved_at, retry_reasons FROM jobs WHERE id = ?').get(id) as { reserved_at: number | null, retry_reasons: string }
    expect(row.reserved_at).toBeNull()
    expect(JSON.parse(row.retry_reasons)).toEqual([
      expect.objectContaining({ _tag: 'stale-release' }),
    ])
  })
})
