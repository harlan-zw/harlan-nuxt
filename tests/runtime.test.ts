import type { D1DatabaseLike, D1PreparedStatementLike, JobContext, JobControlResult, JobDefinition, JobMetricsEvent } from '#cf-jobs/server'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { createDurableJobsRuntime, prepareDurableJob } from '#cf-jobs/server'

function prepare(name: string, payload: Record<string, unknown>) {
  return prepareDurableJob({ name, payload, route: { queue: 'q', jobType: name } })
}

function createSqliteD1(): D1DatabaseLike & { _db: DatabaseSync } {
  const db = new DatabaseSync(':memory:')
  return {
    _db: db,
    async exec(query) { db.exec(query) },
    prepare<T = unknown>(query: string): D1PreparedStatementLike<T> {
      const stmt = db.prepare(query)
      let bound: unknown[] = []
      const api: D1PreparedStatementLike<T> = {
        bind(...values) { bound = values; return api },
        async run() { return { success: true, meta: { changes: Number(stmt.run(...(bound as never[])).changes) } } },
        async first<R = T>() { return (stmt.get(...(bound as never[])) ?? null) as R | null },
        async all<R = T>() { return { results: stmt.all(...(bound as never[])) as R[] } },
      }
      return api
    },
  }
}

// In-memory queue binding capturing send/sendBatch.
function createQueueBinding() {
  const messages: Array<{ jobId: string, queue: string }> = []
  return {
    messages,
    binding: {
      send: (m: { jobId: string, queue: string }) => { messages.push(m) },
      sendBatch: (batch: Array<{ jobId: string, queue: string }>) => { messages.push(...batch) },
    },
  }
}

interface Handlers { [name: string]: (payload: Record<string, unknown>, ctx: JobContext<unknown, unknown, unknown>) => Promise<void> }

function createRegistry(handlers: Handlers) {
  // Only known names are defined/handled — an unknown name fails to dispatch
  // (handler + definition both undefined), which is the terminal-failure path
  // that actually writes a failed_jobs row + fires the onJobFailed hook.
  const def = (name: string): JobDefinition<string, unknown, string, unknown, unknown, unknown> | undefined =>
    name in handlers ? { name, queue: 'q', jobType: name, handle: handlers[name]! } : undefined
  return {
    getHandler: (name: string) => handlers[name],
    getJobDefinition: (name: string) => def(name),
    getJobRoute: (name: string) => ({ queue: 'q', jobType: name }),
  }
}

function ctxFactory(control: JobControlResult): JobContext<unknown, unknown, unknown> {
  return {
    env: {},
    db: {},
    log: undefined,
    jobId: 'x',
    batchId: null,
    attempt: 1,
    async release(delaySeconds) { control.handled = true; control.action = 'released'; control.delaySeconds = delaySeconds },
    async fail(error) { control.handled = true; control.action = 'failed'; control.error = error },
  }
}

async function setup(handlers: Handlers, extra: { metricsSink?: { record: (e: JobMetricsEvent) => void }, onBatchProgress?: (p: unknown) => void } = {}) {
  const d1 = createSqliteD1()
  const { messages, binding } = createQueueBinding()
  const runtime = createDurableJobsRuntime({
    db: d1,
    env: { Q: binding },
    registry: createRegistry(handlers),
    resolveQueueBinding: () => 'Q',
    createJobContext: ({ control }) => ctxFactory(control),
    ...extra,
  })
  await runtime.repository.migrate()
  return { d1, runtime, messages }
}

function rows(d1: ReturnType<typeof createSqliteD1>, table: string): number {
  return Number((d1._db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
}

const msg = (jobId: string) => ({ body: { jobId, queue: 'q' }, ack: vi.fn(), retry: vi.fn() })

describe('createDurableJobsRuntime — batch happy path', () => {
  it('consumes members, settles the batch, fires onFinish once, emits progress + metrics', async () => {
    const events: JobMetricsEvent[] = []
    const progress: Array<{ completed: number, total: number }> = []
    const { d1, runtime, messages } = await setup(
      { work: async () => {}, finish: async () => {} },
      { metricsSink: { record: e => void events.push(e) }, onBatchProgress: p => void progress.push(p as never) },
    )

    const { jobIds } = await runtime.createBatch({
      jobs: [await prepare('work', { n: 1 }), await prepare('work', { n: 2 })],
      onFinish: { name: 'finish', payload: {} },
    })
    expect(rows(d1, 'jobs')).toBe(2)
    expect(messages).toHaveLength(2) // both members dispatched

    const r1 = await runtime.consumeMessage(msg(jobIds[0]!))
    expect(r1.run.status).toBe('completed')
    expect(r1.settled?.batchComplete).toBe(false)

    const r2 = await runtime.consumeMessage(msg(jobIds[1]!))
    expect(r2.run.status).toBe('completed')
    expect(r2.settled?.batchComplete).toBe(true)
    expect(r2.settled?.onFinishDispatched).toBe(true)

    // onFinish enqueued the continuation durably: a new 'finish' row + a send
    expect(rows(d1, 'jobs')).toBe(3)
    expect(messages.some(m => m.queue === 'q' && jobIds.includes(m.jobId) === false)).toBe(true)

    expect(progress.map(p => p.completed)).toEqual([1, 2])
    expect(events).toHaveLength(2)
    expect(events.every(e => e.status === 'completed' && e.queue === 'q' && e.jobType === 'work')).toBe(true)
  })
})

describe('createDurableJobsRuntime — failed member', () => {
  it('settles a terminally-failed member, persists it, and records a failed metric', async () => {
    const events: JobMetricsEvent[] = []
    // 'ghost' has no handler/definition → dispatch-failed (terminal) → failJob.
    const { d1, runtime } = await setup(
      { work: async () => {}, finish: async () => {} },
      { metricsSink: { record: e => void events.push(e) } },
    )

    const { jobIds } = await runtime.createBatch({
      jobs: [await prepare('work', {}), await prepare('ghost', {})],
      onFinish: { name: 'finish', payload: {} },
    })

    await runtime.consumeMessage(msg(jobIds[0]!))
    const r2 = await runtime.consumeMessage(msg(jobIds[1]!))

    expect(r2.run.status).toBe('dispatch-failed')
    expect(r2.settled?.batchComplete).toBe(true)
    expect(r2.settled?.progress?.failed).toBe(1)
    expect(rows(d1, 'failed_jobs')).toBe(1) // ghost moved to failed_jobs
    expect(events.map(e => e.status).sort()).toEqual(['completed', 'failed'])
  })
})
