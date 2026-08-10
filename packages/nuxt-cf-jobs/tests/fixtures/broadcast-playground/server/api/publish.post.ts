import {
  cfJobBatchChannel,
  cfJobChannel,
  cfJobsChannel,
  publishCfJobsBroadcast,
} from '#cf-jobs/server'

type PublishBody
  = | { kind: 'job', jobId?: string }
    | { kind: 'batch', batchId?: string }
    | { kind: 'site', siteId?: string }

interface LocalDurableNamespace {
  idFromName: (name: string) => string
  get: (id: string) => {
    publish: (topic: string, data: unknown, opts?: { compress?: boolean }) => Promise<void>
  }
}

interface BroadcastPlaygroundGlobal {
  __cfJobsBroadcastPlaygroundEnv?: { $DurableObject: LocalDurableNamespace }
}

export default defineEventHandler(async (event) => {
  const body = await readJsonBody<PublishBody>(event)
  const env = (globalThis as typeof globalThis & BroadcastPlaygroundGlobal).__cfJobsBroadcastPlaygroundEnv
  if (!env)
    throw createError({ statusCode: 500, statusMessage: 'Local broadcast env missing' })

  if (body.kind === 'batch') {
    const channel = cfJobBatchChannel(body.batchId ?? 'playground-batch')
    const sent = await publishCfJobsBroadcast(env, channel, 'batch.progress', {
      batchId: body.batchId ?? 'playground-batch',
      name: 'playground',
      completed: 1,
      total: 1,
      failed: 0,
      finishedAt: 1,
    })
    return { sent, channel, event: 'batch.progress' }
  }

  if (body.kind === 'site') {
    const channel = cfJobsChannel('site', body.siteId ?? 'playground-site')
    const sent = await publishCfJobsBroadcast(env, channel, 'playground.site', {
      ok: true,
      siteId: body.siteId ?? 'playground-site',
    })
    return { sent, channel, event: 'playground.site' }
  }

  const channel = cfJobChannel(body.jobId ?? 'playground-job')
  const sent = await publishCfJobsBroadcast(env, channel, 'job.completed', {
    jobId: body.jobId ?? 'playground-job',
    queue: 'default',
    jobType: 'demo/job',
    status: 'completed',
    attempts: 1,
    durationMs: 12,
    batchId: null,
    result: { message: 'done' },
  })
  return { sent, channel, event: 'job.completed' }
})

async function readJsonBody<T>(event: { req?: { text?: () => Promise<string>, json?: () => Promise<T> }, node?: { req?: AsyncIterable<Uint8Array | string> } }): Promise<T> {
  if (typeof event.req?.json === 'function')
    return event.req.json()

  if (typeof event.req?.text === 'function')
    return JSON.parse(await event.req.text()) as T

  let raw = ''
  for await (const chunk of event.node?.req ?? [])
    raw += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)

  return (raw ? JSON.parse(raw) : {}) as T
}
