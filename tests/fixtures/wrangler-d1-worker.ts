import {
  claimDurableJob,
  completeDurableJob,
  defineJob,
  defineJobRegistry,
  dispatchRegisteredJob,
  failDurableJob,
  prepareDurableJob,
  releaseDurableJob,
  toQueueJobMessage,
} from '../../src/runtime/server/index'

interface Env {
  DB: D1Database
  JOBS: Queue<Record<string, unknown>>
}

interface DurableJob {
  id: string
  queue: string
  job_type: string
  batch_id: string | null
  user_id: number | null
  site_id: string | null
  trace_id: string | null
  unique_key: string | null
  payload: string
  attempts: number
  max_attempts: number
  reserved_at: number | null
  available_at: number
  created_at: number
  completed_at: number | null
  failed_at: number | null
  last_error: string | null
}

const registry = defineJobRegistry([
  defineJob({
    name: 'd1/succeed',
    queue: 'default',
    tries: 4,
    unique: true,
    uniqueId: payload => `message:${payload.message}`,
    async handle(payload: { message: string }, ctx: { db: D1Database, jobId: string }) {
      await ctx.db.prepare('UPDATE jobs SET rows_fetched = ?, rows_inserted = ? WHERE id = ?')
        .bind(payload.message.length, 1, ctx.jobId)
        .run()
    },
  }),
  defineJob({
    name: 'd1/fail',
    queue: 'default',
    tries: 1,
    async handle(_payload: { message: string }, ctx: { fail: (error: string) => Promise<void> }) {
      await ctx.fail('forced failure')
    },
  }),
])

function json(body: unknown, init?: ResponseInit) {
  return Response.json(body, {
    headers: { 'cache-control': 'no-store' },
    ...init,
  })
}

async function migrate(db: D1Database) {
  const statements = [
    'CREATE TABLE IF NOT EXISTS jobs (id text PRIMARY KEY, queue text NOT NULL, job_type text NOT NULL, batch_id text, user_id integer, site_id text, trace_id text, unique_key text, payload text NOT NULL, attempts integer DEFAULT 0, max_attempts integer DEFAULT 3, reserved_at integer, available_at integer NOT NULL, created_at integer NOT NULL DEFAULT (unixepoch()), completed_at integer, failed_at integer, last_error text, retry_reasons text, rows_fetched integer, rows_inserted integer, d1_rows_read integer, d1_rows_written integer, duration_ms integer)',
    'CREATE TABLE IF NOT EXISTS failed_jobs (id text PRIMARY KEY, queue text NOT NULL, job_type text NOT NULL, batch_id text, user_id integer, site_id text, trace_id text, unique_key text, payload text NOT NULL, exception text NOT NULL, attempts integer NOT NULL, max_attempts integer NOT NULL, failed_at integer NOT NULL)',
    'CREATE INDEX IF NOT EXISTS idx_jobs_trace ON jobs (trace_id)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_unique_active ON jobs (unique_key) WHERE unique_key IS NOT NULL AND completed_at IS NULL AND failed_at IS NULL',
    'CREATE INDEX IF NOT EXISTS idx_failed_jobs_trace ON failed_jobs (trace_id)',
  ]

  for (const statement of statements)
    await db.exec(statement)
}

async function reset(db: D1Database) {
  await migrate(db)
  await db.exec('DELETE FROM failed_jobs')
  await db.exec('DELETE FROM jobs')
}

async function getJob(db: D1Database, id: string): Promise<DurableJob | null> {
  return await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<DurableJob>()
}

async function dispatch(env: Env, task: 'd1/succeed' | 'd1/fail', message: string) {
  const definition = registry.getJobDefinition(task)
  const record = await prepareDurableJob({
    name: task,
    payload: { message },
    route: { queue: 'default', jobType: 'e2e' },
    definition: definition as never,
    siteId: 'site_1',
    userId: 1,
  })

  await env.DB.prepare(`
    INSERT INTO jobs (
      id, queue, job_type, batch_id, user_id, site_id, trace_id, unique_key, payload,
      attempts, max_attempts, available_at, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    record.id,
    record.queue,
    record.jobType,
    record.batchId ?? null,
    record.userId ?? null,
    record.siteId ?? null,
    record.traceId,
    record.uniqueKey ?? null,
    record.payload,
    record.attempts,
    record.maxAttempts,
    record.availableAt,
    record.createdAt,
  ).run()

  await env.JOBS.send(toQueueJobMessage(record))
  return record
}

async function claimJob(db: D1Database, id: string): Promise<DurableJob | null> {
  const now = Math.floor(Date.now() / 1000)
  const result = await db.prepare(`
    UPDATE jobs
    SET reserved_at = ?, attempts = attempts + 1
    WHERE id = ?
      AND reserved_at IS NULL
      AND available_at <= ?
      AND completed_at IS NULL
      AND failed_at IS NULL
    RETURNING *
  `).bind(now, id, now).first<DurableJob>()
  return result
}

async function completeJob(db: D1Database, id: string) {
  await db.prepare('UPDATE jobs SET completed_at = unixepoch(), reserved_at = NULL WHERE id = ?')
    .bind(id)
    .run()
}

async function failJob(db: D1Database, job: DurableJob, exception: string) {
  await db.prepare(`
    INSERT INTO failed_jobs (
      id, queue, job_type, batch_id, user_id, site_id, trace_id, unique_key, payload,
      exception, attempts, max_attempts, failed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
  `).bind(
    job.id,
    job.queue,
    job.job_type,
    job.batch_id,
    job.user_id,
    job.site_id,
    job.trace_id,
    job.unique_key,
    job.payload,
    exception,
    job.attempts,
    job.max_attempts,
  ).run()
  await db.prepare('DELETE FROM jobs WHERE id = ?').bind(job.id).run()
}

function createLifecycle(db: D1Database) {
  return {
    claimJob: (id: string) => claimJob(db, id),
    async resolveClaimMiss() {
      return 'already-resolved' as const
    },
    completeJob: (job: DurableJob) => completeJob(db, job.id),
    failJob: (job: DurableJob, error: string) => failJob(db, job, error),
    releaseJob: async (job: DurableJob, opts?: { delaySeconds?: number, error?: string }) => {
      await db.prepare('UPDATE jobs SET reserved_at = NULL, available_at = unixepoch() + ?, last_error = ? WHERE id = ?')
        .bind(opts?.delaySeconds ?? 0, opts?.error ?? null, job.id)
        .run()
    },
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/reset') {
      await reset(env.DB)
      return json({ ok: true })
    }

    if (request.method === 'POST' && url.pathname === '/dispatch') {
      await migrate(env.DB)
      const body = await request.json<{ task?: unknown, message?: unknown }>().catch(() => ({}))
      const task = body.task === 'd1/fail' ? 'd1/fail' : 'd1/succeed'
      const message = typeof body.message === 'string' ? body.message : 'd1'
      const record = await dispatch(env, task, message)
      return json({ queued: true, id: record.id, traceId: record.traceId, uniqueKey: record.uniqueKey })
    }

    if (request.method === 'GET' && url.pathname.startsWith('/jobs/')) {
      await migrate(env.DB)
      const id = url.pathname.split('/').at(-1)!
      const job = await getJob(env.DB, id)
      const failed = await env.DB.prepare('SELECT * FROM failed_jobs WHERE id = ?').bind(id).first()
      return json({ job, failed })
    }

    return json({ error: 'not found' }, { status: 404 })
  },

  async queue(batch: MessageBatch<Record<string, unknown>>, env: Env) {
    await migrate(env.DB)
    const lifecycle = createLifecycle(env.DB)
    for (const message of batch.messages) {
      const body = message.body as { jobId?: unknown }
      if (typeof body.jobId !== 'string') {
        message.ack()
        continue
      }

      const claimed = await claimDurableJob(lifecycle, body.jobId)
      if (claimed.status !== 'claimed') {
        message.ack()
        continue
      }
      const job = claimed.job

      try {
        const result = await dispatchRegisteredJob({
          registry,
          job: {
            id: job.id,
            queue: job.queue,
            attempts: job.attempts,
            batchId: job.batch_id,
            siteId: job.site_id,
            userId: job.user_id,
            payload: JSON.parse(job.payload) as Record<string, unknown>,
          },
          createContext: ({ control }) => ({
            env,
            db: env.DB,
            log: console,
            jobId: job.id,
            batchId: job.batch_id,
            attempt: job.attempts,
            async release(delaySeconds: number) {
              control.handled = true
              control.action = 'released'
              control.delaySeconds = delaySeconds
              await releaseDurableJob(lifecycle, job, { delaySeconds })
              message.retry({ delaySeconds })
            },
            async fail(error: string) {
              control.handled = true
              control.action = 'failed'
              control.error = error
              await failDurableJob(lifecycle, job, error)
            },
          }),
        })

        if (result.success && !result.control?.handled)
          await completeDurableJob(lifecycle, job)
        message.ack()
      }
      catch (error) {
        await releaseDurableJob(lifecycle, job, { error: error instanceof Error ? error.message : String(error) })
        message.retry({ delaySeconds: 1 })
      }
    }
  },
}
