import type { D1DatabaseLike, D1PreparedStatementLike } from '#cf-jobs/server'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { createCfJobsApp, defineJob, prepareDurableJob } from '#cf-jobs/server'

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

function createApp(reconcile?: { staleSeconds?: number }) {
  return createCfJobsApp([defineJob({ name: 'x', queue: 'q', handle: vi.fn() })], {
    useRuntimeConfig: () => ({ cfJobs: { queues: { q: { binding: 'Q' } }, reconcile } }) as never,
  })
}

async function seedReserved(d1: ReturnType<typeof createSqliteD1>, runtime: { repository: { insertJob: (record: never) => Promise<boolean> } }, reservedAt: number) {
  const record = await prepareDurableJob({ name: 'x', payload: {}, route: { queue: 'q', jobType: 'x' } })
  await runtime.repository.insertJob(record as never)
  d1._db.prepare('UPDATE jobs SET reserved_at = ? WHERE id = ?').run(reservedAt, record.id)
  return record.id
}

describe('one reservation window', () => {
  it('reclaims an abandoned reservation at the configured reconcile.staleSeconds', async () => {
    const d1 = createSqliteD1()
    const runtime = createApp({ staleSeconds: 900 }).createDurableRuntime({
      db: d1,
      env: {},
      createJobContext: (() => ({})) as never,
      prune: (async () => ({})) as never,
    })
    await runtime.repository.migrate()
    const now = Math.floor(Date.now() / 1000)

    const abandoned = await seedReserved(d1, runtime, now - 1_000)
    expect(await runtime.repository.claimJob(abandoned)).not.toBeNull()

    const owned = await seedReserved(d1, runtime, now - 60)
    expect(await runtime.repository.claimJob(owned)).toBeNull()
  })

  it('leaves reservations untouched when no reconcile window is configured', async () => {
    const d1 = createSqliteD1()
    const runtime = createApp(undefined).createDurableRuntime({
      db: d1,
      env: {},
      createJobContext: (() => ({})) as never,
      prune: (async () => ({})) as never,
    })
    await runtime.repository.migrate()
    const now = Math.floor(Date.now() / 1000)

    const stale = await seedReserved(d1, runtime, now - 100_000)
    expect(await runtime.repository.claimJob(stale)).toBeNull()
  })

  it('lets an explicit reclaimAfterSeconds win over the reconcile window', async () => {
    const d1 = createSqliteD1()
    const runtime = createApp({ staleSeconds: 100_000 }).createDurableRuntime({
      db: d1,
      env: {},
      reclaimAfterSeconds: 60,
      createJobContext: (() => ({})) as never,
      prune: (async () => ({})) as never,
    })
    await runtime.repository.migrate()
    const now = Math.floor(Date.now() / 1000)

    const id = await seedReserved(d1, runtime, now - 120)
    expect(await runtime.repository.claimJob(id)).not.toBeNull()
  })
})
