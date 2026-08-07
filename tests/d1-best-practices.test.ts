import type { D1DatabaseLike, D1DurableJobRecord, D1PreparedStatementLike } from '#cf-jobs/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import {
  createD1DurableJobRepository,
  d1DurableJobMigrationSql,
  listD1BatchMembers,
} from '#cf-jobs/server'
import { snapshotDurableQueues } from '../src/runtime/server/dev-worker-snapshot'

function queryPlan(db: DatabaseSync, sql: string): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()
  return rows.map(row => String((row as { detail: unknown }).detail)).join('\n')
}

describe('d1 best-practice query shapes', () => {
  it('indexes global dispatch and stale-reservation recovery scans', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(d1DurableJobMigrationSql.join(';\n'))

    const dispatchable = queryPlan(db, `
      SELECT * FROM jobs
      WHERE reserved_at IS NULL
        AND published_at IS NULL
        AND available_at <= 100
        AND (NULL IS NULL OR created_at <= NULL)
        AND completed_at IS NULL
        AND failed_at IS NULL
      ORDER BY available_at ASC
      LIMIT 100
    `)
    const stale = queryPlan(db, `
      SELECT * FROM jobs
      WHERE reserved_at IS NOT NULL
        AND reserved_at <= 100
        AND completed_at IS NULL
        AND failed_at IS NULL
      ORDER BY reserved_at ASC
      LIMIT 100
    `)

    expect(dispatchable).toContain('idx_jobs_dispatchable')
    expect(dispatchable).not.toContain('USE TEMP B-TREE')
    expect(stale).toContain('idx_jobs_stale_reserved')
    expect(stale).not.toContain('USE TEMP B-TREE')
  })

  it('indexes oldest-first published orphan recovery without hot reservation columns', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(d1DurableJobMigrationSql.join(';\n'))

    const recovery = queryPlan(db, `
      SELECT * FROM jobs
      WHERE reserved_at IS NULL
        AND available_at <= 100
        AND created_at <= 50
        AND completed_at IS NULL
        AND failed_at IS NULL
      ORDER BY created_at ASC
      LIMIT 100
    `)
    const indexes = db.prepare('SELECT name FROM sqlite_master WHERE type = \'index\'').all().map(row => String((row as { name: unknown }).name))

    expect(recovery).toContain('idx_jobs_active')
    expect(recovery).not.toContain('USE TEMP B-TREE')
    expect(indexes).not.toContain('idx_jobs_claimable')
    expect(indexes).not.toContain('idx_job_batches_pending')
    expect(indexes).not.toContain('idx_jobs_trace')
    expect(indexes).not.toContain('idx_failed_jobs_trace')
  })

  it('indexes ordered failed-job evidence by batch and site', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(d1DurableJobMigrationSql.join(';\n'))

    const byBatch = queryPlan(db, 'SELECT * FROM failed_jobs WHERE batch_id = ? ORDER BY failed_at DESC')
    const bySite = queryPlan(db, 'SELECT * FROM failed_jobs WHERE site_id = ? AND failed_at >= ? ORDER BY failed_at DESC')

    expect(byBatch)
      .toContain('idx_failed_jobs_batch')
    expect(byBatch).not.toContain('USE TEMP B-TREE')
    expect(bySite).toContain('idx_failed_jobs_site')
    expect(bySite).not.toContain('USE TEMP B-TREE')
  })

  it('records orphan redispatch evidence with one set-based write', async () => {
    const queries: string[] = []
    const bindings: unknown[][] = []
    const run = vi.fn(async () => ({ success: true, meta: { changes: 3 } }))
    const batch = vi.fn(async () => [])
    const db: D1DatabaseLike = {
      exec: vi.fn(async () => {}),
      batch,
      prepare<T = unknown>(query: string): D1PreparedStatementLike<T> {
        queries.push(query)
        const statement: D1PreparedStatementLike<T> = {
          bind: (...values) => {
            bindings.push(values)
            return statement
          },
          run,
          first: async () => null,
        }
        return statement
      },
    }

    const changed = await createD1DurableJobRepository(db)
      .noteOrphanRedispatch(['a', 'b', 'c'], { at: 100 })

    expect(changed).toBe(3)
    expect(run).toHaveBeenCalledOnce()
    expect(batch).not.toHaveBeenCalled()
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain('id IN (SELECT value FROM json_each(?))')
    expect(bindings[0]).toContain('["a","b","c"]')
  })

  it('keeps the Wrangler consumer on the canonical D1 repository schema', () => {
    const worker = readFileSync(resolve('tests/fixtures/wrangler-d1-worker.ts'), 'utf8')

    expect(worker).toContain('createD1DurableJobRepository')
    expect(worker).not.toContain('CREATE TABLE IF NOT EXISTS jobs')
    expect(worker).not.toContain('function createLifecycle')
  })

  it('moves a terminal failure with one transactional D1 batch', async () => {
    const run = vi.fn(async () => ({ success: true, meta: { changes: 1 } }))
    const batch = vi.fn(async (statements: D1PreparedStatementLike<unknown>[]) =>
      statements.map(() => ({ success: true, meta: { changes: 1 } })))
    const db: D1DatabaseLike = {
      exec: vi.fn(async () => {}),
      batch,
      prepare<T = unknown>(): D1PreparedStatementLike<T> {
        const statement: D1PreparedStatementLike<T> = {
          bind: () => statement,
          run,
          first: async () => null,
        }
        return statement
      },
    }
    const repository = createD1DurableJobRepository(db)
    const job = {
      id: 'job_1',
      reserved_at: 100,
      attempts: 1,
    } as D1DurableJobRecord

    await repository.failJob(job, 'boom')

    expect(batch).toHaveBeenCalledOnce()
    expect(batch.mock.calls[0]?.[0]).toHaveLength(2)
    expect(run).not.toHaveBeenCalled()
  })

  it('batches independent inspection reads into one D1 round trip', async () => {
    const batch = vi.fn()
      .mockResolvedValueOnce([
        { success: true, results: [{ id: 'active', jobType: 'work', reservedAt: null, completedAt: null }] },
        { success: true, results: [{ id: 'failed', jobType: 'work' }] },
      ])
      .mockResolvedValueOnce([
        { success: true, results: [{ queue: 'q', ready: 2, reserved: 0, delayed: 0, completed: 1 }] },
        { success: true, results: [{ queue: 'q', failed: 3 }] },
      ])
    const db: D1DatabaseLike = {
      exec: vi.fn(async () => {}),
      batch,
      prepare<T = unknown>(): D1PreparedStatementLike<T> {
        const statement: D1PreparedStatementLike<T> = {
          bind: () => statement,
          run: async () => ({ success: true }),
          first: async () => null,
          all: async () => {
            throw new Error('batch path expected')
          },
        }
        return statement
      },
    }

    await expect(listD1BatchMembers(db, 'batch')).resolves.toEqual([
      { id: 'active', jobType: 'work', state: 'pending' },
      { id: 'failed', jobType: 'work', state: 'failed' },
    ])
    await expect(snapshotDurableQueues(db, {}, 100)).resolves.toEqual([
      { queue: 'q', ready: 2, reserved: 0, delayed: 0, completed: 1, failed: 3 },
    ])
    expect(batch).toHaveBeenCalledTimes(2)
    expect(batch.mock.calls.every(call => call[0].length === 2)).toBe(true)
  })
})
