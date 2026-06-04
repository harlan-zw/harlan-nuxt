import type { D1DatabaseLike, D1PreparedStatementLike } from '#cf-jobs/server'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  createD1DurableBatchStore,
  createD1DurableJobRepository,
  createJobBatch,
  createParentJobBatch,
  d1DurableJobMigrationSql,
  prepareDurableJob,
  settleBatchMember,
} from '#cf-jobs/server'

// A synchronous node:sqlite-backed D1 adapter so the batch lifecycle runs against
// the real migration SQL (UPDATE ... RETURNING single-winner decrement), not a
// hand-rolled fake. node:sqlite is synchronous, which matches D1's single-writer
// serialization for the concurrency guarantee under test.
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
          const r = stmt.run(...(bound as never[]))
          return { success: true, meta: { changes: Number(r.changes) } }
        },
        async first<Result = T>() {
          const row = stmt.get(...(bound as never[]))
          return (row ?? null) as Result | null
        },
        async all<Result = T>() {
          return { results: stmt.all(...(bound as never[])) as Result[] }
        },
      }
      return api
    },
  }
}

function createRecordingPublisher() {
  const sent: Array<{ queue: string, messages: unknown[] }> = []
  return {
    sent,
    publisher: {
      async sendBatch(queue: string, messages: unknown[]) {
        sent.push({ queue, messages })
        return true
      },
    },
  }
}

async function prepareJob(name: string, payload: Record<string, unknown>, queue = 'default') {
  return prepareDurableJob({ name, payload, route: { queue, jobType: name } })
}

async function setupBatchEnv() {
  const db = createSqliteD1()
  const repo = createD1DurableJobRepository(db)
  await repo.migrate()
  const store = createD1DurableBatchStore(db)
  const { publisher, sent } = createRecordingPublisher()
  return { db, repo, store, publisher, sent }
}

function countRows(db: { _db: DatabaseSync }, table: string): number {
  return (db._db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
}

describe('createJobBatch', () => {
  it('inserts a batch row, persists members with the batch id, and dispatches them', async () => {
    const { db, repo, store, publisher, sent } = await setupBatchEnv()

    const jobs = await Promise.all([
      prepareJob('scan/crawl', { siteId: 's1' }),
      prepareJob('scan/crux', { siteId: 's1' }),
      prepareJob('scan/lighthouse', { siteId: 's1' }),
    ])

    const result = await createJobBatch({
      store,
      repository: repo,
      publisher,
      jobs,
      name: 'onboarding:s1',
      siteId: 's1',
      onFinish: { name: 'assess/site', payload: { siteId: 's1' } },
    })

    expect(result.batchId).toBeTruthy()
    expect(result.jobIds).toHaveLength(3)
    expect(countRows(db, 'job_batches')).toBe(1)
    expect(countRows(db, 'jobs')).toBe(3)

    const batchRow = db._db.prepare('SELECT * FROM job_batches').get() as Record<string, unknown>
    expect(batchRow.total_jobs).toBe(3)
    expect(batchRow.pending_jobs).toBe(3)
    expect(batchRow.on_finish).toContain('assess/site')

    // every member row carries the batch id
    const memberBatchIds = db._db.prepare('SELECT DISTINCT batch_id FROM jobs').all() as Array<{ batch_id: string }>
    expect(memberBatchIds).toEqual([{ batch_id: result.batchId }])

    // dispatched once per queue (all share 'default')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.messages).toHaveLength(3)
  })

  it('is a no-op for an empty job list (a zero-member batch would never finish)', async () => {
    const { db, repo, store, publisher, sent } = await setupBatchEnv()
    const result = await createJobBatch({
      store,
      repository: repo,
      publisher,
      jobs: [],
      onFinish: { name: 'assess/site', payload: { siteId: 's1' } },
    })
    expect(result).toEqual({ batchId: '', jobIds: [], dispatched: [] })
    expect(countRows(db, 'job_batches')).toBe(0)
    expect(sent).toHaveLength(0)
  })
})

describe('settleBatchMember', () => {
  it('fires onFinish exactly once, on the settle that brings pending to 0', async () => {
    const { repo, store, publisher } = await setupBatchEnv()
    const jobs = await Promise.all([
      prepareJob('scan/crawl', { siteId: 's1' }),
      prepareJob('scan/crux', { siteId: 's1' }),
      prepareJob('scan/lighthouse', { siteId: 's1' }),
    ])
    const { batchId, jobIds } = await createJobBatch({
      store,
      repository: repo,
      publisher,
      jobs,
      onFinish: { name: 'assess/site', payload: { siteId: 's1' } },
    })

    const fired: Array<{ name: string, payload: unknown }> = []
    const dispatchOnFinish = async ({ continuation }: { continuation: { name: string, payload: unknown } }) => {
      fired.push({ name: continuation.name, payload: continuation.payload })
    }

    const r1 = await settleBatchMember({ store, jobId: jobIds[0], dispatchOnFinish })
    expect(r1.batchComplete).toBe(false)
    expect(r1.progress).toMatchObject({ completed: 1, total: 3 })

    const r2 = await settleBatchMember({ store, jobId: jobIds[1], dispatchOnFinish })
    expect(r2.batchComplete).toBe(false)

    const r3 = await settleBatchMember({ store, jobId: jobIds[2], dispatchOnFinish })
    expect(r3.batchComplete).toBe(true)
    expect(r3.onFinishDispatched).toBe(true)

    expect(fired).toHaveLength(1)
    expect(fired[0]!.name).toBe('assess/site')
    // batchId is injected into the onFinish payload
    expect(fired[0]!.payload).toMatchObject({ siteId: 's1', batchId })
  })

  it('elects a single winner under concurrent settles', async () => {
    const { repo, store, publisher } = await setupBatchEnv()
    const jobs = await Promise.all(
      Array.from({ length: 8 }, (_, i) => prepareJob('scan/x', { i })),
    )
    const { jobIds } = await createJobBatch({
      store,
      repository: repo,
      publisher,
      jobs,
      onFinish: { name: 'done', payload: {} },
    })

    let fireCount = 0
    const dispatchOnFinish = async () => {
      fireCount++
    }

    const results = await Promise.all(
      jobIds.map(jobId => settleBatchMember({ store, jobId, dispatchOnFinish })),
    )

    const winners = results.filter(r => r.batchComplete)
    expect(winners).toHaveLength(1)
    expect(winners[0]!.onFinishDispatched).toBe(true)
    expect(fireCount).toBe(1)
  })

  it('counts failed members and still fires onFinish on terminal', async () => {
    const { db, repo, store, publisher } = await setupBatchEnv()
    const jobs = await Promise.all([
      prepareJob('scan/crawl', { siteId: 's1' }),
      prepareJob('scan/crux', { siteId: 's1' }),
    ])
    const { jobIds } = await createJobBatch({
      store,
      repository: repo,
      publisher,
      jobs,
      onFinish: { name: 'assess/site', payload: { siteId: 's1' } },
    })

    let fired = 0
    const dispatchOnFinish = async () => {
      fired++
    }

    // first member completes, second member permanently fails
    await settleBatchMember({ store, jobId: jobIds[0], dispatchOnFinish })
    const final = await settleBatchMember({ store, jobId: jobIds[1], failed: true, dispatchOnFinish })

    expect(final.batchComplete).toBe(true)
    expect(final.progress!.failed).toBe(1)
    expect(fired).toBe(1)

    const batchRow = db._db.prepare('SELECT failed_jobs, finished_at FROM job_batches').get() as { failed_jobs: number, finished_at: number | null }
    expect(batchRow.failed_jobs).toBe(1)
    expect(batchRow.finished_at).toBeTypeOf('number')
  })

  it('resolves the batch from a member that has moved to failed_jobs', async () => {
    const { repo, store, publisher } = await setupBatchEnv()
    const jobs = await Promise.all([prepareJob('scan/crawl', { siteId: 's1' })])
    const { jobIds } = await createJobBatch({ store, repository: repo, publisher, jobs, onFinish: { name: 'done', payload: {} } })

    // simulate the consumer moving the job to failed_jobs before settling
    const claimed = await repo.claimJob(jobIds[0]!)
    await repo.failJob(claimed!, 'boom')

    let fired = 0
    const res = await settleBatchMember({ store, jobId: jobIds[0], failed: true, dispatchOnFinish: async () => { fired++ } })
    expect(res.batchComplete).toBe(true)
    expect(fired).toBe(1)
  })

  it('returns inert when the job has no batch', async () => {
    const { store } = await setupBatchEnv()
    const res = await settleBatchMember({ store, jobId: 'nope' })
    expect(res).toEqual({ batchComplete: false, onFinishDispatched: false })
  })
})

describe('parent batches', () => {
  it('fires the parent onFinish once every child batch completes', async () => {
    const { repo, store, publisher } = await setupBatchEnv()

    const fired: string[] = []
    const dispatchOnFinish = async ({ continuation }: { continuation: { name: string } }) => {
      fired.push(continuation.name)
    }

    const parentId = await createParentJobBatch({
      store,
      name: 'parent',
      onFinish: { name: 'parent/done', payload: {} },
    })

    const childAJobs = await Promise.all([prepareJob('a', { n: 1 }), prepareJob('a', { n: 2 })])
    const childBJobs = await Promise.all([prepareJob('b', { n: 1 })])

    const childA = await createJobBatch({ store, repository: repo, publisher, jobs: childAJobs, parentBatchId: parentId, onFinish: { name: 'childA/done', payload: {} } })
    const childB = await createJobBatch({ store, repository: repo, publisher, jobs: childBJobs, parentBatchId: parentId, onFinish: { name: 'childB/done', payload: {} } })

    // drain child A
    await settleBatchMember({ store, jobId: childA.jobIds[0], dispatchOnFinish })
    await settleBatchMember({ store, jobId: childA.jobIds[1], dispatchOnFinish })
    expect(fired).toContain('childA/done')
    expect(fired).not.toContain('parent/done')

    // drain child B → completes parent
    await settleBatchMember({ store, jobId: childB.jobIds[0], dispatchOnFinish })
    expect(fired).toContain('childB/done')
    expect(fired).toContain('parent/done')
    expect(fired.filter(f => f === 'parent/done')).toHaveLength(1)
  })
})
