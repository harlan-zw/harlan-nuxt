import type { D1DatabaseLike, D1PreparedStatementLike } from '#cf-jobs/server'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  claimDurableJob,
  completeDurableJob,
  createD1DurableJobRepository,
  findDispatchableDurableJobs,
  prepareDurableJob,
} from '#cf-jobs/server'
import { resolveQueueWorkerConfig, runDevWorkerTick } from '../src/runtime/server/dev-worker'

// End-to-end-ish coverage for the dev worker: drive `runDevWorkerTick` against
// the REAL D1 durable repository (in-memory SQLite) with a consumer that runs
// the real claim→complete lifecycle. This proves the `{ jobId, queue }` messages
// the worker emits are consumable exactly as the app's `cloudflare:queue`
// consumer would, and that ready/grouping/sizing line up with the actual SQL.
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

async function seedJob(repo: ReturnType<typeof createD1DurableJobRepository>, queue: string, jobType: string) {
  const rec = await prepareDurableJob({ name: jobType, payload: { jobType }, route: { queue, jobType } })
  await repo.insertJob(rec)
  return rec.id
}

/**
 * A stand-in for the app's registered consumer: reads the worker's message,
 * claims the durable row, runs it (here: a no-op), and completes it. Records
 * which job ids actually ran and the size of each batch it received.
 */
function recordingConsumer(repo: ReturnType<typeof createD1DurableJobRepository>) {
  const ran: string[] = []
  const batchSizes: number[] = []
  async function dispatchBatch(_queue: string, messages: ReadonlyArray<{ jobId: string, queue: string }>) {
    batchSizes.push(messages.length)
    for (const message of messages) {
      const claimed = await claimDurableJob(repo, message.jobId)
      if (claimed.status !== 'claimed')
        continue
      ran.push(claimed.job.id)
      await completeDurableJob(repo, claimed.job)
    }
  }
  return { dispatchBatch, ran, batchSizes }
}

describe('dev worker over the real D1 repository', () => {
  it('drains ready durable jobs through a real claim→complete consumer', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()

    const ids = [
      await seedJob(repo, 'alpha', 'a'),
      await seedJob(repo, 'alpha', 'a'),
      await seedJob(repo, 'beta', 'b'),
    ]
    const consumer = recordingConsumer(repo)

    const result = await runDevWorkerTick({
      findDispatchable: max => findDispatchableDurableJobs(repo, { limit: max }),
      queueConfig: () => resolveQueueWorkerConfig(undefined),
      dispatchBatch: consumer.dispatchBatch,
    }, { limit: 100 })

    expect(result.processed).toBe(3)
    expect(result.byQueue).toEqual({ alpha: 2, beta: 1 })
    expect(result.remaining).toBe(0)
    expect(consumer.ran.sort()).toEqual([...ids].sort())

    // The rows are actually gone from the dispatchable set (completed in D1).
    const stillReady = await findDispatchableDurableJobs(repo, { limit: 100 })
    expect(stillReady).toHaveLength(0)

    // A second tick is a clean no-op.
    const second = await runDevWorkerTick({
      findDispatchable: max => findDispatchableDurableJobs(repo, { limit: max }),
      queueConfig: () => resolveQueueWorkerConfig(undefined),
      dispatchBatch: consumer.dispatchBatch,
    }, { limit: 100 })
    expect(second.processed).toBe(0)
  })

  it('chunks a queue by its configured maxBatchSize', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    for (let i = 0; i < 5; i++)
      await seedJob(repo, 'q', 't')

    const consumer = recordingConsumer(repo)
    const result = await runDevWorkerTick({
      findDispatchable: max => findDispatchableDurableJobs(repo, { limit: max }),
      queueConfig: () => resolveQueueWorkerConfig({ maxConcurrency: 2, maxBatchSize: 2 }),
      dispatchBatch: consumer.dispatchBatch,
    }, { limit: 100 })

    expect(result.processed).toBe(5)
    expect(consumer.batchSizes.slice().sort()).toEqual([1, 2, 2]) // 5 jobs / batch-size 2
    expect(consumer.ran).toHaveLength(5)
  })

  it('honours a single-queue filter against real data', async () => {
    const d1 = createSqliteD1()
    const repo = createD1DurableJobRepository(d1)
    await repo.migrate()
    await seedJob(repo, 'keep', 'k')
    await seedJob(repo, 'skip', 's')

    const consumer = recordingConsumer(repo)
    const result = await runDevWorkerTick({
      findDispatchable: max => findDispatchableDurableJobs(repo, { limit: max }),
      queueConfig: () => resolveQueueWorkerConfig(undefined),
      dispatchBatch: consumer.dispatchBatch,
    }, { limit: 100, queue: 'keep' })

    expect(result.processed).toBe(1)
    expect(result.byQueue).toEqual({ keep: 1 })
    expect(consumer.ran).toHaveLength(1)
    // The skipped queue's job is still ready.
    const stillReady = await findDispatchableDurableJobs(repo, { limit: 100 })
    expect(stillReady.map(r => r.queue)).toEqual(['skip'])
  })
})
