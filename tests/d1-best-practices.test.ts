import type { D1DatabaseLike, D1DurableJobRecord, D1PreparedStatementLike } from '#cf-jobs/server'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import {
  createD1DurableJobRepository,
  d1DurableJobMigrationSql,
} from '#cf-jobs/server'

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

  it('indexes failed-job evidence by batch', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(d1DurableJobMigrationSql.join(';\n'))

    expect(queryPlan(db, 'SELECT COUNT(*) FROM failed_jobs WHERE batch_id = ?'))
      .toContain('idx_failed_jobs_batch')
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
})
