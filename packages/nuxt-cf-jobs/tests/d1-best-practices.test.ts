import type { D1DatabaseLike, D1DurableJobRecord, D1PreparedStatementLike } from '#cf-jobs/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import {
  createD1DurableBatchStore,
  createD1DurableJobRepository,
  d1DurableJobMigrationSql,
  listD1BatchMembers,
  prepareDurableJob,
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

  it('drops redundant jobs indexes and recreates nullable indexes as partial during migrate', async () => {
    const sqlite = new DatabaseSync(':memory:')
    // Seed a database with the previous 11-index `jobs` and non-partial `job_batches` schema.
    sqlite.exec(`
      CREATE TABLE job_batches (id text PRIMARY KEY, name text, parent_batch_id text, total_jobs integer NOT NULL DEFAULT 0, pending_jobs integer NOT NULL DEFAULT 0, failed_jobs integer NOT NULL DEFAULT 0, on_finish text, handler text, allow_failures integer DEFAULT 0, site_id text, user_id integer, created_at integer NOT NULL DEFAULT (unixepoch()), updated_at integer NOT NULL DEFAULT (unixepoch()), finished_at integer);
      CREATE TABLE jobs (id text PRIMARY KEY, queue text NOT NULL, job_type text NOT NULL, batch_id text REFERENCES job_batches(id), user_id integer, site_id text, partner_id text, trace_id text, unique_key text, payload text NOT NULL, attempts integer DEFAULT 0, max_attempts integer DEFAULT 3, backoff text, reserved_at integer, available_at integer NOT NULL, created_at integer NOT NULL DEFAULT (unixepoch()), published_at integer, last_dispatched_at integer, dispatch_attempts integer NOT NULL DEFAULT 0, last_dispatch_error text, completed_at integer, failed_at integer, last_error text, retry_reasons text, rows_fetched integer, rows_inserted integer, d1_rows_read integer, d1_rows_written integer, duration_ms integer);
      CREATE TABLE failed_jobs (id text PRIMARY KEY, queue text NOT NULL, job_type text NOT NULL, batch_id text, user_id integer, site_id text, partner_id text, trace_id text, unique_key text, payload text NOT NULL, exception text NOT NULL, attempts integer NOT NULL, max_attempts integer NOT NULL, failed_at integer NOT NULL);
      CREATE INDEX idx_job_batches_site ON job_batches (site_id);
      CREATE INDEX idx_jobs_user ON jobs (user_id);
      CREATE INDEX idx_jobs_site ON jobs (site_id);
      CREATE INDEX idx_jobs_partner ON jobs (partner_id);
      CREATE INDEX idx_jobs_batch ON jobs (batch_id);
      CREATE INDEX idx_jobs_sync_dedup ON jobs (site_id, job_type);
    `)

    const d1: D1DatabaseLike = {
      async exec(query) { sqlite.exec(query) },
      prepare<T = unknown>(query: string): D1PreparedStatementLike<T> {
        const stmt = sqlite.prepare(query)
        let bound: unknown[] = []
        const api: D1PreparedStatementLike<T> = {
          bind(...values) {
            bound = values
            return api
          },
          async run() {
            return { success: true, meta: { changes: Number(stmt.run(...(bound as never[])).changes) } }
          },
          async first<R = T>() { return (stmt.get(...(bound as never[])) ?? null) as R | null },
          async all<R = T>() { return { results: stmt.all(...(bound as never[])) as R[] } },
        }
        return api
      },
    }

    await createD1DurableJobRepository(d1).migrate()

    const indexes = new Map(
      (sqlite.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL`).all() as Array<{ name: string, sql: string }>)
        .map(row => [row.name, row.sql]),
    )

    expect(indexes.has('idx_jobs_site')).toBe(false)
    expect(indexes.has('idx_jobs_user')).toBe(false)
    expect(indexes.has('idx_jobs_partner')).toBe(false)
    expect(indexes.get('idx_jobs_batch')).toMatch(/WHERE batch_id IS NOT NULL/i)
    expect(indexes.get('idx_jobs_sync_dedup')).toMatch(/WHERE site_id IS NOT NULL/i)
    expect(indexes.get('idx_job_batches_site')).toMatch(/WHERE site_id IS NOT NULL/i)
    // Indexes kept specifically to prevent read regressions in package and downstream sites.
    expect(indexes.has('idx_jobs_type')).toBe(true)
    expect(indexes.has('idx_job_batches_parent')).toBe(true)
    expect(indexes.has('idx_job_batches_finished_at')).toBe(true)
  })

  it('keeps indexed query plans across all package and downstream query shapes after index reduction', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(d1DurableJobMigrationSql.join(';\n'))

    const now = 1_800_000_000
    const insBatch = db.prepare(`INSERT INTO job_batches (id, name, parent_batch_id, total_jobs, pending_jobs, failed_jobs, site_id, created_at, updated_at, finished_at) VALUES (?, ?, ?, 10, ?, 0, ?, ?, ?, ?)`)
    for (let i = 0; i < 200; i++) {
      const finished = i < 190 ? now - 3600 - i * 60 : null
      insBatch.run(`b_${i}`, i % 2 === 0 ? `refresh:s_${i % 20}` : `daily-sync:2026-11-01`, i % 10 === 0 ? null : `b_${Math.floor(i / 10) * 10}`, finished ? 0 : 3, i % 4 === 0 ? null : `s_${i % 20}`, now - 7200, now - 3600, finished)
    }
    const insJob = db.prepare(`INSERT INTO jobs (id, queue, job_type, batch_id, site_id, unique_key, payload, attempts, max_attempts, reserved_at, available_at, created_at, published_at, completed_at) VALUES (?, 'q', ?, ?, ?, ?, '{}', 0, 3, ?, ?, ?, ?, ?)`)
    const types = ['sync', 'crawl-slice', 'assessment', 'registry/repository-submission']
    for (let i = 0; i < 2_000; i++) {
      const active = i >= 1980
      insJob.run(`j_${i}`, types[i % types.length]!, i % 3 === 0 ? `b_${i % 200}` : null, i % 5 === 0 ? null : `s_${i % 20}`, i % 4 === 0 ? `uk_${i}` : null, i >= 1990 ? now - 1200 : null, now - 1000, now - 1000, i >= 1995 ? null : now - 1000, active ? null : now - 300 - i)
    }
    db.exec('ANALYZE')

    // Site-only lookup moves cleanly onto idx_jobs_sync_dedup left prefix.
    expect(queryPlan(db, `SELECT id FROM jobs WHERE site_id = 's_1'`)).toContain('SEARCH jobs USING INDEX idx_jobs_sync_dedup (site_id=?)')
    expect(queryPlan(db, `SELECT id FROM jobs WHERE site_id IN ('s_1', 's_2')`)).toContain('SEARCH jobs USING INDEX idx_jobs_sync_dedup (site_id=?)')
    // Site + job_type dedup uses partial idx_jobs_sync_dedup.
    expect(queryPlan(db, `SELECT 1 FROM jobs WHERE site_id = 's_1' AND job_type = 'crawl-slice' AND completed_at IS NULL AND failed_at IS NULL LIMIT 1`)).toContain('SEARCH jobs USING INDEX idx_jobs_sync_dedup (site_id=? AND job_type=?)')
    // Completed job_type lookup stays indexed via kept idx_jobs_type.
    expect(queryPlan(db, `SELECT 1 FROM jobs WHERE job_type = 'registry/repository-submission' AND completed_at IS NOT NULL`)).toContain('SEARCH jobs USING INDEX idx_jobs_type (job_type=?)')
    // Batch member lookups stay indexed via partial idx_jobs_batch.
    expect(queryPlan(db, `SELECT id, job_type FROM jobs WHERE batch_id = 'b_1'`)).toContain('SEARCH jobs USING INDEX idx_jobs_batch (batch_id=?)')
    expect(queryPlan(db, `SELECT id FROM jobs WHERE batch_id IN ('b_1', 'b_2')`)).toContain('SEARCH jobs USING INDEX idx_jobs_batch (batch_id=?)')
    // Downstream INDEXED BY idx_job_batches_site pins remain valid against the partial index.
    expect(queryPlan(db, `SELECT id FROM (SELECT 's_1' AS value UNION ALL SELECT 's_2' AS value) req CROSS JOIN job_batches INDEXED BY idx_job_batches_site WHERE site_id = req.value AND finished_at IS NULL`)).toContain('SEARCH job_batches USING INDEX idx_job_batches_site (site_id=?)')
    // Open batches, finished retention, and top-level/child parent queries stay indexed.
    expect(queryPlan(db, `SELECT id FROM job_batches WHERE finished_at IS NULL AND pending_jobs > 0`)).toContain('SEARCH job_batches USING INDEX idx_job_batches_finished_at (finished_at=?)')
    expect(queryPlan(db, `SELECT id FROM job_batches INDEXED BY idx_job_batches_finished_at WHERE finished_at IS NOT NULL AND finished_at <= 1799900000`)).toContain('SEARCH job_batches USING INDEX idx_job_batches_finished_at (finished_at>? AND finished_at<?)')
    expect(queryPlan(db, `SELECT id FROM job_batches WHERE parent_batch_id IS NULL`)).toContain('SEARCH job_batches USING INDEX idx_job_batches_parent (parent_batch_id=?)')
    expect(queryPlan(db, `SELECT id FROM job_batches WHERE parent_batch_id = 'b_0'`)).toContain('SEARCH job_batches USING INDEX idx_job_batches_parent (parent_batch_id=?)')
  })

  it('reduces B-tree writes across job inserts and avoids rewriting idx_job_batches_finished_at on intermediate batch decrements', async () => {
    // Count SQLite B-tree write operations executed for a statement on a database:
    // table row (1) + every secondary index entry inserted or deleted. For INSERT/UPDATE
    // we also inspect EXPLAIN OpenWrite rootpages to prove which index B-trees SQLite
    // even opens at compile time.
    function openedIndexNames(db: DatabaseSync, sql: string): string[] {
      const byRoot = new Map(
        (db.prepare(`SELECT rootpage, name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ rootpage: number, name: string }>)
          .map(row => [row.rootpage, row.name]),
      )
      const ops = db.prepare(`EXPLAIN ${sql}`).all() as Array<{ opcode: string, p2: number }>
      return ops
        .filter(op => op.opcode === 'OpenWrite' && byRoot.has(op.p2))
        .map(op => byRoot.get(op.p2)!)
    }

    function activeSecondaryIndexesForJob(db: DatabaseSync, jobId: string): string[] {
      const indexes = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs' AND sql IS NOT NULL`).all() as Array<{ name: string, sql: string }>
      const present: string[] = []
      for (const idx of indexes) {
        const whereIdx = idx.sql.toUpperCase().indexOf(' WHERE ')
        if (whereIdx === -1) {
          present.push(idx.name)
          continue
        }
        const predicate = idx.sql.slice(whereIdx + ' WHERE '.length)
        const matched = db.prepare(`SELECT 1 AS ok FROM jobs WHERE id = ? AND (${predicate})`).get(jobId) as { ok?: number } | undefined
        if (matched?.ok === 1)
          present.push(idx.name)
      }
      return present
    }

    function createInstrumentedSqliteD1() {
      const db = new DatabaseSync(':memory:')
      const executed: string[] = []
      const d1: D1DatabaseLike = {
        async exec(query) { db.exec(query) },
        async batch(statements) {
          db.exec('BEGIN')
          const results: Array<{ success?: boolean, meta?: { changes?: number }, results?: unknown[] }> = []
          try {
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
            bind(...values) {
              bound = values
              return api
            },
            async run() {
              executed.push(query)
              if (stmt.columns().length > 0) {
                const rows = stmt.all(...(bound as never[])) as T[]
                return { success: true, meta: { changes: rows.length }, results: rows }
              }
              return { success: true, meta: { changes: Number(stmt.run(...(bound as never[])).changes) } }
            },
            async first<R = T>() {
              executed.push(query)
              return (stmt.get(...(bound as never[])) ?? null) as R | null
            },
            async all<R = T>() {
              executed.push(query)
              return { results: stmt.all(...(bound as never[])) as R[] }
            },
          }
          return api
        },
      }
      return { db, d1, executed }
    }

    // 1. Compare B-tree writes on INSERT INTO jobs across legacy (11 secondary indexes)
    //    vs optimized (8 secondary indexes, nullable ones partial) schemas.
    const legacy = new DatabaseSync(':memory:')
    legacy.exec(`
      CREATE TABLE job_batches (id text PRIMARY KEY);
      CREATE TABLE jobs (id text PRIMARY KEY, queue text NOT NULL, job_type text NOT NULL, batch_id text, user_id integer, site_id text, partner_id text, trace_id text, unique_key text, payload text NOT NULL, attempts integer DEFAULT 0, max_attempts integer DEFAULT 3, backoff text, reserved_at integer, available_at integer NOT NULL, created_at integer NOT NULL DEFAULT (unixepoch()), published_at integer, last_dispatched_at integer, dispatch_attempts integer NOT NULL DEFAULT 0, last_dispatch_error text, completed_at integer, failed_at integer, last_error text, retry_reasons text, rows_fetched integer, rows_inserted integer, d1_rows_read integer, d1_rows_written integer, duration_ms integer);
      CREATE INDEX idx_jobs_dispatchable ON jobs (available_at) WHERE published_at IS NULL AND reserved_at IS NULL AND completed_at IS NULL AND failed_at IS NULL;
      CREATE INDEX idx_jobs_stale_reserved ON jobs (reserved_at) WHERE reserved_at IS NOT NULL AND completed_at IS NULL AND failed_at IS NULL;
      CREATE INDEX idx_jobs_active ON jobs (created_at) WHERE completed_at IS NULL AND failed_at IS NULL;
      CREATE INDEX idx_jobs_user ON jobs (user_id);
      CREATE INDEX idx_jobs_site ON jobs (site_id);
      CREATE INDEX idx_jobs_partner ON jobs (partner_id);
      CREATE INDEX idx_jobs_type ON jobs (job_type);
      CREATE INDEX idx_jobs_batch ON jobs (batch_id);
      CREATE INDEX idx_jobs_sync_dedup ON jobs (site_id, job_type);
      CREATE INDEX idx_jobs_completed_at ON jobs (completed_at) WHERE completed_at IS NOT NULL;
      CREATE UNIQUE INDEX idx_jobs_unique_active ON jobs (unique_key) WHERE unique_key IS NOT NULL AND completed_at IS NULL AND failed_at IS NULL;
      INSERT INTO job_batches (id) VALUES ('batch_1');
    `)

    const { db: optimized, d1, executed } = createInstrumentedSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    const store = createD1DurableBatchStore(d1)
    await repo.migrate()
    await store.insertBatch({ id: 'batch_1', totalJobs: 3, pendingJobs: 3, siteId: 'site_1' })

    const siteBatchJob = await prepareDurableJob({ id: 'j_site_batch', name: 'sync/table', payload: {}, route: { queue: 'q', jobType: 'sync' }, batchId: 'batch_1', siteId: 'site_1', userId: 7, now: 100 })
    const siteOnlyJob = await prepareDurableJob({ id: 'j_site_only', name: 'crawl/slice', payload: {}, route: { queue: 'q', jobType: 'crawl-slice' }, siteId: 'site_1', now: 100 })
    const systemJob = await prepareDurableJob({ id: 'j_system', name: 'sys/tick', payload: {}, route: { queue: 'q', jobType: 'sys' }, now: 100 })

    for (const record of [siteBatchJob, siteOnlyJob, systemJob]) {
      legacy.prepare(`INSERT INTO jobs (id, queue, job_type, batch_id, user_id, site_id, partner_id, trace_id, unique_key, payload, attempts, max_attempts, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 3, 100, 100)`)
        .run(record.id, record.queue, record.jobType, record.batchId ?? null, record.userId ?? null, record.siteId ?? null, record.partnerId ?? null, record.traceId, record.uniqueKey ?? null, record.payload)
      await repo.stageJob(record)
    }

    // Base table (1) + PK autoindex (1) + active secondary indexes = total B-tree writes on INSERT.
    const rowsWrittenOnInsert = (db: DatabaseSync, id: string) => 2 + activeSecondaryIndexesForJob(db, id).length
    // Site + batch job: 10 -> 7 (-3: dropped site, user, partner).
    expect(rowsWrittenOnInsert(legacy, 'j_site_batch')).toBe(10)
    expect(rowsWrittenOnInsert(optimized, 'j_site_batch')).toBe(7)
    // Site-only (non-batch) job: 10 -> 6 (-4: also skips partial idx_jobs_batch).
    expect(rowsWrittenOnInsert(legacy, 'j_site_only')).toBe(10)
    expect(rowsWrittenOnInsert(optimized, 'j_site_only')).toBe(6)
    // System job (no site, no batch): 10 -> 5 (-5: also skips partial idx_jobs_sync_dedup).
    expect(rowsWrittenOnInsert(legacy, 'j_system')).toBe(10)
    expect(rowsWrittenOnInsert(optimized, 'j_system')).toBe(5)

    // 2. Run full job lifecycle (publish -> claim -> complete -> intermediate & final batch decrements)
    //    and prove intermediate batch decrements never open idx_job_batches_finished_at.
    await repo.markJobsPublished(['j_site_batch'], { at: 101 })
    expect(activeSecondaryIndexesForJob(optimized, 'j_site_batch')).not.toContain('idx_jobs_dispatchable')

    const claimed = await repo.claimJob('j_site_batch')
    expect(claimed).not.toBeNull()
    expect(activeSecondaryIndexesForJob(optimized, 'j_site_batch')).toContain('idx_jobs_stale_reserved')

    await repo.completeJob(claimed!, { durationMs: 50 })
    const afterComplete = activeSecondaryIndexesForJob(optimized, 'j_site_batch')
    expect(afterComplete).not.toContain('idx_jobs_stale_reserved')
    expect(afterComplete).not.toContain('idx_jobs_active')
    expect(afterComplete).toContain('idx_jobs_completed_at')

    // Intermediate decrement via repository settlement (pending_jobs 3 -> 2):
    executed.length = 0
    const settled1 = await repo.completePendingSettlement!(claimed!, 'completed', { batchId: 'batch_1' })
    expect(settled1.batch?.pendingJobs).toBe(2)
    expect(settled1.batch?.finishedAt).toBeNull()
    const intermediateSettlementUpdate = executed.find(sql => sql.includes('UPDATE job_batches') && sql.includes('pending_jobs > 1'))
    expect(intermediateSettlementUpdate).toBeTruthy()
    expect(openedIndexNames(optimized, intermediateSettlementUpdate!)).not.toContain('idx_job_batches_finished_at')

    // Intermediate decrement via batch store (pending_jobs 2 -> 1):
    executed.length = 0
    const dec2 = await store.decrementPending('batch_1')
    expect(dec2?.pendingJobs).toBe(1)
    expect(dec2?.finishedAt).toBeNull()
    const intermediateStoreUpdate = executed.find(sql => sql.includes('UPDATE job_batches') && sql.includes('pending_jobs > 1'))
    expect(intermediateStoreUpdate).toBeTruthy()
    expect(openedIndexNames(optimized, intermediateStoreUpdate!)).not.toContain('idx_job_batches_finished_at')

    // Final decrement (pending_jobs 1 -> 0): sets finished_at atomically once.
    const dec3 = await store.decrementPending('batch_1')
    expect(dec3?.pendingJobs).toBe(0)
    expect(dec3?.finishedAt).toBeTypeOf('number')

    // Replay on an already-finished batch is a no-op.
    expect(await store.decrementPending('batch_1')).toBeNull()
  })
})
