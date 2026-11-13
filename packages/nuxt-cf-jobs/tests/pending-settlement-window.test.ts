import type { D1DatabaseLike, D1PreparedStatementLike } from '#cf-jobs/server'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createD1DurableJobRepository } from '#cf-jobs/server'

// Records each statement with its bindings, so the test can ask SQLite how it
// plans the exact query the repository sent.
function createSqliteD1() {
  const db = new DatabaseSync(':memory:')
  const sent: Array<{ query: string, bound: unknown[] }> = []
  const d1: D1DatabaseLike = {
    async exec(query: string) {
      db.exec(query)
    },
    prepare<T = unknown>(query: string): D1PreparedStatementLike<T> {
      const stmt = db.prepare(query)
      const entry = { query, bound: [] as unknown[] }
      sent.push(entry)
      const api: D1PreparedStatementLike<T> = {
        bind(...values: unknown[]) {
          entry.bound = values
          return api
        },
        async run() {
          return { success: true, meta: { changes: Number(stmt.run(...(entry.bound as never[])).changes) } }
        },
        async first<Result = T>() {
          return (stmt.get(...(entry.bound as never[])) ?? null) as Result | null
        },
        async all<Result = T>() {
          return { results: stmt.all(...(entry.bound as never[])) as Result[] }
        },
      }
      return api
    },
  }
  return { db, d1, sent }
}

const NOW = 2_000_000_000
const HOUR = 3600
const LEASE = 900

function settlement(done: boolean, leaseUntil: number) {
  return JSON.stringify({ _cfJobsSettlement: { status: 'completed', attempts: 1, token: 'initial:1', leaseUntil, batches: [], done } })
}

function seedCompleted(db: DatabaseSync, id: string, completedAt: number, done: boolean) {
  db.prepare(`INSERT INTO jobs (id, queue, job_type, payload, available_at, completed_at) VALUES (?, 'q', 't', ?, 0, ?)`)
    .run(id, settlement(done, completedAt + LEASE), completedAt)
}

function seedFailed(db: DatabaseSync, id: string, failedAt: number, done: boolean) {
  db.prepare(`INSERT INTO failed_jobs (id, queue, job_type, payload, exception, attempts, max_attempts, failed_at) VALUES (?, 'q', 't', ?, 'e', 1, 3, ?)`)
    .run(id, settlement(done, failedAt + LEASE), failedAt)
}

async function setup() {
  const sqlite = createSqliteD1()
  const repo = createD1DurableJobRepository(sqlite.d1, { reclaimAfterSeconds: LEASE })
  await repo.migrate()
  return { ...sqlite, repo }
}

describe('findPendingSettlements', () => {
  it('reads only the terminal window through the timestamp indexes', async () => {
    const { db, sent, repo } = await setup()
    // Planner statistics like a busy production table: most rows terminal.
    for (let i = 0; i < 2000; i++)
      seedCompleted(db, `c${i}`, NOW - 30 * HOUR + i * 60, true)
    for (let i = 0; i < 500; i++)
      seedFailed(db, `f${i}`, NOW - 30 * HOUR + i * 200, true)
    db.exec('ANALYZE')

    await repo.findPendingSettlements!({ now: NOW, terminalAfter: NOW - 6 * HOUR, limit: 100 })
    const sql = sent.at(-1)!
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql.query}`).all(...(sql.bound as never[])).map(row => String((row as { detail: unknown }).detail)).join('\n')

    expect(plan).not.toMatch(/SCAN (jobs|failed_jobs)/)
    expect(plan).toContain('SEARCH jobs USING INDEX idx_jobs_completed_at (completed_at>? AND completed_at<?)')
    expect(plan).toContain('SEARCH failed_jobs USING INDEX idx_failed_jobs_failed_at (failed_at>? AND failed_at<?)')
  })

  it('finds expired flags inside the window and ignores rows outside it', async () => {
    const { db, repo } = await setup()
    seedCompleted(db, 'pending-in-window', NOW - 2 * HOUR, false)
    seedCompleted(db, 'pending-too-old', NOW - 7 * HOUR, false)
    seedCompleted(db, 'done-in-window', NOW - 2 * HOUR, true)
    // Still inside its first lease: the consumer may be running the follow-up.
    seedCompleted(db, 'pending-leased', NOW - 60, false)
    seedFailed(db, 'failed-in-window', NOW - 3 * HOUR, false)
    seedFailed(db, 'failed-too-old', NOW - 8 * HOUR, false)
    seedFailed(db, 'failed-done', NOW - 3 * HOUR, true)

    const found = await repo.findPendingSettlements!({ now: NOW, terminalAfter: NOW - 6 * HOUR, limit: 100 })

    expect(found.map(row => row.id).sort()).toEqual(['failed-in-window', 'pending-in-window'])
  })

  it('finds a flag whose lease expired at the window edge', async () => {
    const { db, repo } = await setup()
    seedCompleted(db, 'edge', NOW - LEASE, false)
    seedFailed(db, 'failed-edge', NOW - LEASE, false)

    const found = await repo.findPendingSettlements!({ now: NOW, terminalAfter: NOW - 6 * HOUR, limit: 100 })

    expect(found.map(row => row.id).sort()).toEqual(['edge', 'failed-edge'])
  })
})
