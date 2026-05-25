import {
  buildJobPayload,
  defineJob,
  defineJobRegistry,
  dispatchRegisteredJob,
} from '../../src/runtime/server/index'

interface Env {
  JOBS: Queue<Record<string, unknown>>
}

interface E2EState {
  handled: string[]
  middleware: string[]
  failures: string[]
}

const state: E2EState = ((globalThis as typeof globalThis & { __CF_JOBS_E2E__?: E2EState }).__CF_JOBS_E2E__ ??= {
  handled: [],
  middleware: [],
  failures: [],
})

const registry = defineJobRegistry([
  defineJob({
    name: 'e2e/send',
    queue: 'default',
    tries: 2,
    backoff: [1, 2],
    middleware: [
      async (payload: { message: string }, _ctx: unknown, next) => {
        state.middleware.push(`before:${payload.message}`)
        await next()
        state.middleware.push(`after:${payload.message}`)
      },
    ],
    async handle(payload: { message: string }) {
      state.handled.push(payload.message)
    },
  }),
])

function json(body: unknown, init?: ResponseInit) {
  return Response.json(body, {
    headers: { 'cache-control': 'no-store' },
    ...init,
  })
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/reset') {
      state.handled = []
      state.middleware = []
      state.failures = []
      return json({ ok: true })
    }

    if (request.method === 'GET' && url.pathname === '/state')
      return json(state)

    if (request.method === 'POST' && url.pathname === '/dispatch') {
      const body = await request.json<{ message?: unknown }>().catch(() => ({}))
      if (typeof body.message !== 'string' || body.message.length === 0)
        return json({ error: 'message is required' }, { status: 422 })

      await env.JOBS.send(buildJobPayload('e2e/send', { message: body.message }))
      return json({ queued: true })
    }

    return json({ error: 'not found' }, { status: 404 })
  },

  async queue(batch: MessageBatch<Record<string, unknown>>, env: Env) {
    for (const message of batch.messages) {
      try {
        const result = await dispatchRegisteredJob({
          registry,
          job: {
            id: message.id,
            queue: batch.queue,
            attempts: message.attempts,
            batchId: null,
            payload: message.body,
          },
          createContext: ({ control, job }) => ({
            env,
            db: null,
            log: console,
            jobId: job.id,
            batchId: null,
            attempt: job.attempts,
            async release(delaySeconds: number) {
              control.handled = true
              control.action = 'released'
              control.delaySeconds = delaySeconds
              message.retry({ delaySeconds })
            },
            async fail(error: string) {
              control.handled = true
              control.action = 'failed'
              control.error = error
              state.failures.push(error)
              message.ack()
            },
          }),
        })

        if (result.success)
          message.ack()
      }
      catch (error) {
        state.failures.push(error instanceof Error ? error.message : String(error))
        throw error
      }
    }
  },
}
