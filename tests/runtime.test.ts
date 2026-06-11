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
        bind(...values) {
          bound = values
          return api
        },
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
    // Only known tasks route — an unknown onFinish continuation then fails to
    // prepare, exercising the dispatchOnFinish error path.
    getJobRoute: (name: string) => (name in handlers ? { queue: 'q', jobType: name } : undefined),
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
    async release(delaySeconds) {
      control.handled = true
      control.action = 'released'
      control.delaySeconds = delaySeconds
    },
    async fail(error) {
      control.handled = true
      control.action = 'failed'
      control.error = error
    },
  }
}

async function setup(handlers: Handlers, extra: Record<string, unknown> = {}) {
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

describe('ctx.reportStats → metrics + job row (JOB_ANALYTICS parity)', () => {
  it('forwards reported execution stats to the metrics event and persists them', async () => {
    const events: JobMetricsEvent[] = []
    const { d1, runtime } = await setup(
      {
        crawl: async (_p, ctx) => {
          ctx.reportStats?.({ rowsFetched: 30, d1RowsRead: 12 })
          ctx.reportStats?.({ rowsFetched: 12, rowsInserted: 5, d1RowsWritten: 4 }) // accumulates
        },
        finish: async () => {},
      },
      { metricsSink: { record: e => void events.push(e) } },
    )
    const { jobIds } = await runtime.createBatch({ jobs: [await prepare('crawl', {})], onFinish: { name: 'finish', payload: {} } })

    await runtime.consumeMessage(msg(jobIds[0]!))

    const e = events.find(x => x.status === 'completed')!
    expect(e).toMatchObject({ rowsFetched: 42, rowsInserted: 5, d1RowsRead: 12, d1RowsWritten: 4 })
    expect(typeof e.durationMs).toBe('number') // derived from the reservation
    const row = d1._db.prepare('SELECT rows_fetched, rows_inserted, d1_rows_read, d1_rows_written FROM jobs WHERE id = ?').get(jobIds[0]!) as Record<string, number>
    expect(row).toMatchObject({ rows_fetched: 42, rows_inserted: 5, d1_rows_read: 12, d1_rows_written: 4 })
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

describe('runDurableJobMessage control handling (lifecycle fix)', () => {
  it('ctx.fail() persists to failed_jobs, settles, and records a failed metric', async () => {
    const events: JobMetricsEvent[] = []
    const { d1, runtime } = await setup(
      { stop: async (_p, ctx) => { await ctx.fail('deliberate') }, finish: async () => {} },
      { metricsSink: { record: e => void events.push(e) } },
    )
    const { jobIds } = await runtime.createBatch({ jobs: [await prepare('stop', {})], onFinish: { name: 'finish', payload: {} } })

    const r = await runtime.consumeMessage(msg(jobIds[0]!))
    expect(r.run.status).toBe('failed')
    expect(r.settled?.batchComplete).toBe(true)
    expect(rows(d1, 'failed_jobs')).toBe(1)
    expect(rows(d1, 'jobs')).toBe(1) // only the durably-enqueued onFinish 'finish' remains
    expect(events.map(e => e.status)).toEqual(['failed'])
  })

  it('ctx.release() redelivers the message (retry) instead of dropping it', async () => {
    const m = msg('will-be-set')
    const { d1, runtime } = await setup({ flaky: async (_p, ctx) => {
      await ctx.release(7)
    } })
    const { jobIds } = await runtime.createBatch({ jobs: [await prepare('flaky', {})], onFinish: { name: 'flaky', payload: {} } })
    m.body.jobId = jobIds[0]!

    const r = await runtime.consumeMessage(m)
    expect(r.run.status).toBe('released')
    expect(r.settled).toBeNull() // not terminal → batch not settled
    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 7 })
    expect(m.ack).not.toHaveBeenCalled()
    // released, not dropped: row survives with its reservation cleared
    const row = d1._db.prepare('SELECT reserved_at, completed_at, failed_at FROM jobs WHERE id = ?').get(jobIds[0]!) as { reserved_at: number | null, completed_at: number | null, failed_at: number | null }
    expect(row).toMatchObject({ reserved_at: null, completed_at: null, failed_at: null })
  })
})

describe('maxAttempts (Laravel worker model)', () => {
  it('retries a throwing job below the attempt cap (released, batch not settled)', async () => {
    const { runtime } = await setup({ boom: async () => {
      throw new Error('transient')
    } })
    const { jobIds } = await runtime.createBatch({ jobs: [await prepare('boom', {})], onFinish: { name: 'boom', payload: {} } })
    const m = msg(jobIds[0]!) // default max_attempts 3, attempts→1 after claim < 3
    const r = await runtime.consumeMessage(m)
    expect(r.run.status).toBe('errored')
    expect(r.settled).toBeNull()
    expect(m.retry).toHaveBeenCalled()
    expect(m.ack).not.toHaveBeenCalled()
  })

  it('fails (→ failed_jobs) + settles once attempts reach the cap', async () => {
    const { d1, runtime } = await setup({ boom: async () => {
      throw new Error('persistent')
    }, finish: async () => {} })
    const { jobIds } = await runtime.createBatch({ jobs: [await prepare('boom', {})], onFinish: { name: 'finish', payload: {} } })
    d1._db.prepare('UPDATE jobs SET max_attempts = 1 WHERE id = ?').run(jobIds[0]!)
    const m = msg(jobIds[0]!)
    const r = await runtime.consumeMessage(m)
    expect(r.run.status).toBe('exhausted')
    expect(r.settled?.batchComplete).toBe(true)
    expect(rows(d1, 'failed_jobs')).toBe(1)
    expect(m.ack).toHaveBeenCalled()
    expect(m.retry).not.toHaveBeenCalled()
  })
})

describe('consumeBatch', () => {
  it('routes a lightweight _task message and dedups redeliveries', async () => {
    const ran: number[] = []
    const dedup = new Set<string>()
    const d1 = createSqliteD1()
    const { binding } = createQueueBinding()
    const runtime = createDurableJobsRuntime({
      db: d1,
      env: { Q: binding },
      registry: createRegistry({ light: async p => void ran.push(p.n as number) }),
      resolveQueueBinding: () => 'Q',
      createJobContext: ({ control }) => ctxFactory(control),
      dedup,
    })
    await runtime.repository.migrate()

    const m1 = { id: 'm1', body: { _task: 'light', n: 1 }, attempts: 1, ack: vi.fn(), retry: vi.fn() }
    await runtime.consumeBatch({ queue: 'jobs', messages: [m1] })
    expect(ran).toEqual([1])
    expect(m1.ack).toHaveBeenCalled()

    // same message id redelivered → deduped (handler not run again)
    const m1b = { id: 'm1', body: { _task: 'light', n: 1 }, attempts: 2, ack: vi.fn(), retry: vi.fn() }
    await runtime.consumeBatch({ queue: 'jobs', messages: [m1b] })
    expect(ran).toEqual([1])
    expect(m1b.ack).toHaveBeenCalled()
  })

  it('settles a durable member off a DLQ batch so it cannot hang', async () => {
    const { d1, runtime } = await setup({ work: async () => {}, finish: async () => {} })
    const { jobIds } = await runtime.createBatch({
      jobs: [await prepare('work', {}), await prepare('work', {})],
      onFinish: { name: 'finish', payload: {} },
    })
    // first member completes normally; second lands in the DLQ
    await runtime.consumeBatch({ queue: 'jobs', messages: [msg(jobIds[0]!)] })
    const dlqMsg = { body: { jobId: jobIds[1]! }, attempts: 5, ack: vi.fn(), retry: vi.fn() }
    await runtime.consumeBatch({ queue: 'jobs-dlq', messages: [dlqMsg] })

    expect(dlqMsg.ack).toHaveBeenCalled()
    // both members settled → batch finished → onFinish enqueued 'finish' durably
    const batch = d1._db.prepare('SELECT pending_jobs, finished_at FROM job_batches').get() as { pending_jobs: number, finished_at: number | null }
    expect(batch.pending_jobs).toBe(0)
    expect(batch.finished_at).toBeTypeOf('number')
    // DLQ'd member moved to failed_jobs (Laravel exhausted→failed); jobs holds the
    // completed member0 + the durably-enqueued 'finish'.
    expect(rows(d1, 'failed_jobs')).toBe(1)
    expect(rows(d1, 'jobs')).toBe(2)
  })
})

describe('runtime.prune', () => {
  it('prunes completed rows past their cutoff', async () => {
    const { d1, runtime } = await setup({ work: async () => {} })
    const rec = await prepare('work', {})
    await runtime.repository.insertJob(rec)
    d1._db.prepare('UPDATE jobs SET completed_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 100_000, rec.id)

    const result = await runtime.prune({ completedBefore: Math.floor(Date.now() / 1000) })
    expect(result.completedJobs).toBe(1)
    expect(rows(d1, 'jobs')).toBe(0)
  })

  // Codex review (Area 4): independent cutoffs must not violate the FK.
  it('keeps a finished batch while a member job still references it (FK-safe)', async () => {
    const now = Math.floor(Date.now() / 1000)
    const old = now - 100_000
    const { d1, runtime } = await setup({ work: async () => {} })
    await runtime.store.insertBatch({ id: 'b1', totalJobs: 1, pendingJobs: 0 })
    d1._db.prepare('UPDATE job_batches SET finished_at = ? WHERE id = ?').run(old, 'b1')
    const rec = await prepare('work', {})
    await runtime.repository.insertJob(rec)
    d1._db.prepare('UPDATE jobs SET batch_id = ?, completed_at = ? WHERE id = ?').run('b1', old, rec.id)

    // batch retention shorter than completed-jobs retention → member lingers
    let r = await runtime.prune({ finishedBatchesBefore: now })
    expect(r.finishedBatches).toBe(0) // not pruned while the member references it
    expect(rows(d1, 'job_batches')).toBe(1)

    // once the member is pruned, the batch becomes prunable
    r = await runtime.prune({ completedBefore: now, finishedBatchesBefore: now })
    expect(r.completedJobs).toBe(1)
    expect(r.finishedBatches).toBe(1)
    expect(rows(d1, 'job_batches')).toBe(0)
  })
})

describe('consumeBatch DLQ idempotency (Codex review Area 2/3)', () => {
  it('does not double-settle when a DLQ message is delivered twice', async () => {
    const { d1, runtime } = await setup({ work: async () => {}, finish: async () => {} })
    const { jobIds } = await runtime.createBatch({
      jobs: [await prepare('work', {}), await prepare('work', {})],
      onFinish: { name: 'finish', payload: {} },
    })
    await runtime.consumeBatch({ queue: 'jobs', messages: [msg(jobIds[0]!)] }) // member0 completes → pending 2→1

    const dlq = () => ({ queue: 'jobs-dlq', messages: [{ body: { jobId: jobIds[1]! }, attempts: 5, ack: vi.fn(), retry: vi.fn() }] })
    await runtime.consumeBatch(dlq()) // first: claim+fail+settle → pending 1→0, onFinish fires
    await runtime.consumeBatch(dlq()) // duplicate: claim misses → MUST skip settle

    const batch = d1._db.prepare('SELECT pending_jobs FROM job_batches').get() as { pending_jobs: number }
    expect(batch.pending_jobs).toBe(0) // not -1
    // onFinish enqueued exactly once → exactly one 'finish' row (jobs: member0 + finish)
    expect(rows(d1, 'jobs')).toBe(2)
    expect(rows(d1, 'failed_jobs')).toBe(1)
  })
})

describe('gscdump-parity hooks', () => {
  it('wrapDispatch wraps the run; onSettled + then/finally continuations fire on success', async () => {
    const order: string[] = []
    const settled: Array<{ status: string, permanent: boolean, hasDuration: boolean }> = []
    const conts: string[] = []
    const { runtime } = await setup(
      { work: async () => { order.push('run') }, finish: async () => {} },
      {
        createJobScope: () => ({
          wrapDispatch: async (run: () => Promise<unknown>) => {
            order.push('before')
            const r = await run()
            order.push('after')
            return r
          },
          onSettled: (s: { status: string, permanent: boolean, durationMs: number }) => { settled.push({ status: s.status, permanent: s.permanent, hasDuration: typeof s.durationMs === 'number' }) },
        }),
        dispatchContinuations: ({ stage }: { stage: string }) => { conts.push(stage) },
      },
    )
    const { jobIds } = await runtime.createBatch({ jobs: [await prepare('work', {})], onFinish: { name: 'finish', payload: {} } })
    await runtime.consumeMessage(msg(jobIds[0]!))

    expect(order).toEqual(['before', 'run', 'after'])
    expect(settled).toEqual([{ status: 'completed', permanent: false, hasDuration: true }])
    expect(conts).toEqual(['then', 'finally'])
  })

  it('isPermanentFailure decides retry vs terminal; catch/finally continuations on terminal', async () => {
    const conts: string[] = []
    // transient errors are never permanent → always released for retry
    const { d1, runtime } = await setup(
      { boom: async () => { throw new Error('TRANSIENT: rate limited') } },
      {
        isPermanentFailure: ({ error }: { error: unknown }) => !/TRANSIENT/.test(String(error)),
        dispatchContinuations: ({ stage }: { stage: string }) => { conts.push(stage) },
      },
    )
    const { jobIds } = await runtime.createBatch({ jobs: [await prepare('boom', {})], onFinish: { name: 'boom', payload: {} } })
    d1._db.prepare('UPDATE jobs SET max_attempts = 1 WHERE id = ?').run(jobIds[0]!) // at the cap

    const m = msg(jobIds[0]!)
    const r = await runtime.consumeMessage(m)
    expect(r.run.status).toBe('errored') // transient → retried, NOT exhausted, despite attempts >= max
    expect(m.retry).toHaveBeenCalled()
    expect(conts).toEqual([]) // no continuations on a retry
    expect(rows(d1, 'failed_jobs')).toBe(0)
  })

  it('maxBatchCpuMs defers remaining messages', async () => {
    const ran: string[] = []
    const { runtime } = await setup(
      { work: async () => { ran.push('x') } },
      { maxBatchCpuMs: -1, cpuGuardRetryDelaySeconds: 9 }, // budget already blown
    )
    const { jobIds } = await runtime.createBatch({ jobs: [await prepare('work', {})], onFinish: { name: 'work', payload: {} } })
    const m = { body: { jobId: jobIds[0]! }, attempts: 1, ack: vi.fn(), retry: vi.fn() }
    await runtime.consumeBatch({ queue: 'jobs', messages: [m] })

    expect(ran).toEqual([]) // never dispatched — deferred by the guard
    expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 9 })
  })
})

describe('onFinish failure (Codex review Area 5)', () => {
  it('logs and does not throw when the onFinish continuation cannot be enqueued', async () => {
    const logs: Array<{ stage: string }> = []
    const { runtime } = await setup({ work: async () => {} }, { onLog: e => logs.push(e) })
    // 'ghost' has no route → prepareDurableJob throws inside dispatchOnFinish
    const { jobIds } = await runtime.createBatch({ jobs: [await prepare('work', {})], onFinish: { name: 'ghost', payload: {} } })

    const r = await runtime.consumeMessage(msg(jobIds[0]!))
    expect(r.run.status).toBe('completed')
    expect(r.settled?.batchComplete).toBe(true) // batch still finishes
    expect(logs.some(l => l.stage === 'onfinish-failed')).toBe(true)
  })
})
