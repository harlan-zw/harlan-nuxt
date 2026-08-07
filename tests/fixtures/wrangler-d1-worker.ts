import type { D1DatabaseLike, D1DurableJobRecord } from '../../src/runtime/server/index'
import {
  claimDurableJob,
  completeDurableJob,
  createD1DurableJobRepository,
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

function repository(db: D1Database) {
  return createD1DurableJobRepository(db as unknown as D1DatabaseLike)
}

async function reset(db: D1Database) {
  await repository(db).migrate()
  await db.batch([
    db.prepare('DELETE FROM failed_jobs'),
    db.prepare('DELETE FROM jobs'),
    db.prepare('DELETE FROM job_batches'),
  ])
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

  await repository(env.DB).insertJob(record)
  await env.JOBS.send(toQueueJobMessage(record))
  return record
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/health')
      return json({ ok: true })

    if (request.method === 'POST' && url.pathname === '/reset') {
      await reset(env.DB)
      return json({ ok: true })
    }

    if (request.method === 'POST' && url.pathname === '/dispatch') {
      const body = await request.json<{ task?: unknown, message?: unknown }>().catch(() => ({}))
      const task = body.task === 'd1/fail' ? 'd1/fail' : 'd1/succeed'
      const message = typeof body.message === 'string' ? body.message : 'd1'
      const record = await dispatch(env, task, message)
      return json({ queued: true, id: record.id, traceId: record.traceId, uniqueKey: record.uniqueKey })
    }

    if (request.method === 'GET' && url.pathname.startsWith('/jobs/')) {
      const id = url.pathname.split('/').at(-1)!
      const [jobs, failedJobs] = await env.DB.batch([
        env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id),
        env.DB.prepare('SELECT * FROM failed_jobs WHERE id = ?').bind(id),
      ])
      return json({
        job: jobs.results[0] ?? null,
        failed: failedJobs.results[0] ?? null,
      })
    }

    return json({ error: 'not found' }, { status: 404 })
  },

  async queue(batch: MessageBatch<Record<string, unknown>>, env: Env) {
    const lifecycle = repository(env.DB)
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
      const job: D1DurableJobRecord = claimed.job

      try {
        const result = await dispatchRegisteredJob({
          registry,
          job: lifecycle.toDispatchableJob(job),
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
} satisfies ExportedHandler<Env>
