import type { CfJobsBroadcastBatchProgressEvent, CfJobsBroadcastJobEvent, CfJobsBroadcastMessage } from '../shared/broadcast'
import type { BatchProgress } from './batch'
import type { D1DurableJobRecord, D1DurableJobRepositoryOptions } from './d1'
import type { JobMetricsEvent, JobMetricsSink } from './metrics'
import type { ReleaseDurableJobOptions } from './outbox'
import type { JobDefinition } from './types'
import {
  cfJobBatchChannel,
  cfJobChannel,
  cfJobQueueChannel,
  cfJobsBroadcastTopic,
  normalizeCfJobsBroadcastChannels,
} from '../shared/broadcast'

export {
  CF_JOBS_BROADCAST_DEFAULT_ROUTE,
  CF_JOBS_BROADCAST_SYSTEM_CHANNEL,
  CF_JOBS_BROADCAST_TOPIC_PREFIX,
  cfJobBatchChannel,
  cfJobChannel,
  cfJobQueueChannel,
  cfJobsBroadcastTopic,
  cfJobsChannel,
  isCfJobsBroadcastChannel,
  normalizeCfJobsBroadcastChannels,
  parseCfJobsBroadcastCommand,
} from '../shared/broadcast'
export type {
  CfJobsBroadcastBatchProgressEvent,
  CfJobsBroadcastClientCommand,
  CfJobsBroadcastEnvelope,
  CfJobsBroadcastJobEvent,
  CfJobsBroadcastJobStatus,
  CfJobsBroadcastMessage,
} from '../shared/broadcast'

export interface CfJobsBroadcastDurableObjectStub {
  publish: (topic: string, data: unknown, opts?: { compress?: boolean }) => Promise<void>
}

export interface CfJobsBroadcastDurableObjectNamespace {
  idFromName: (name: string) => unknown
  get: (id: unknown) => CfJobsBroadcastDurableObjectStub
}

export interface CfJobsBroadcastEnv extends Record<string, unknown> {}

export interface CfJobsBroadcastJobRegistry<Env = unknown, Db = unknown, Logger = unknown> {
  getJobDefinition?: (name: string) => JobDefinition<string, unknown, string, Env, Db, Logger> | undefined
  loadJobDefinition?: (name: string) => Promise<JobDefinition<string, unknown, string, Env, Db, Logger> | undefined>
}

export interface CfJobsBroadcastRuntimeOptions<Env = unknown, Db = unknown, Logger = unknown> {
  registry?: CfJobsBroadcastJobRegistry<Env, Db, Logger>
}

export interface CfJobsBroadcastOptions {
  /**
   * Durable Object namespace binding used by Nitro's Cloudflare durable preset.
   * NuxtSEO uses `$DurableObject`, so that is the default.
   */
  durableObjectBinding?: string
  /** Named Durable Object instance. Defaults to Nitro's central `server` object. */
  durableObjectName?: string
  compress?: boolean
  /**
   * Include `completeResult` payloads on `job.completed`. Set false if results
   * are large or contain data that should only be fetched through an app API.
   */
  includeResult?: boolean | ((input: { job: D1DurableJobRecord, result: unknown }) => unknown)
  /** Override fan-out channels for a job event. Defaults to job/batch/queue. */
  jobChannels?: (input: { event: CfJobsBroadcastJobEvent, job: Pick<D1DurableJobRecord, 'id' | 'queue' | 'batch_id'> }) => string[] | Promise<string[]>
  /** Override fan-out channels for batch progress. Defaults to batch. */
  batchChannels?: (input: { event: CfJobsBroadcastBatchProgressEvent, progress: BatchProgress }) => string[] | Promise<string[]>
  onError?: (error: unknown, input: { channel: string, event: string }) => void
}

export type CfJobsRuntimeBroadcastOptions = boolean | CfJobsBroadcastOptions

interface PublishOptions extends Pick<CfJobsBroadcastOptions, 'durableObjectBinding' | 'durableObjectName' | 'compress' | 'onError'> {}

const DEFAULT_DO_BINDING = '$DurableObject'
const DEFAULT_DO_NAME = 'server'

export async function publishCfJobsBroadcast<T>(
  env: CfJobsBroadcastEnv | undefined,
  channel: string,
  event: string,
  data: T,
  opts: PublishOptions = {},
): Promise<boolean> {
  const stub = resolveCfJobsBroadcastStub(env, opts)
  if (!stub)
    return false

  try {
    await stub.publish(
      cfJobsBroadcastTopic(channel),
      JSON.stringify({ channel, event, data }),
      opts.compress === undefined ? undefined : { compress: opts.compress },
    )
    return true
  }
  catch (error) {
    opts.onError?.(error, { channel, event })
    return false
  }
}

export async function publishCfJobsBroadcastMany<T>(
  env: CfJobsBroadcastEnv | undefined,
  channels: readonly string[],
  event: string,
  data: T,
  opts: PublishOptions = {},
): Promise<number> {
  let sent = 0
  for (const channel of [...new Set(channels)]) {
    if (await publishCfJobsBroadcast(env, channel, event, data, opts))
      sent += 1
  }
  return sent
}

export function createCfJobsBroadcastRepositoryHooks<
  Queue extends string = string,
  Env = unknown,
  Db = unknown,
  Logger = unknown,
>(
  env: CfJobsBroadcastEnv | undefined,
  opts: CfJobsBroadcastOptions = {},
  runtime: CfJobsBroadcastRuntimeOptions<Env, Db, Logger> = {},
): Pick<D1DurableJobRepositoryOptions<Queue>, 'onJobClaimed' | 'onJobCompleted' | 'onJobFailed' | 'onJobReleased'> {
  return {
    onJobClaimed({ job }) {
      void publishJobEvent(env, job, 'claimed', {}, opts, runtime)
    },
    onJobCompleted({ job, durationMs, result }) {
      const extra: Partial<CfJobsBroadcastJobEvent> = { durationMs }
      const selected = selectCompleteResult(job, result, opts.includeResult)
      if (selected !== undefined)
        extra.result = selected
      void publishJobEvent(env, job, 'completed', extra, opts, runtime)
    },
    onJobFailed({ job, error }) {
      void publishJobEvent(env, job, 'failed', { durationMs: job.duration_ms ?? null, error }, opts, runtime)
    },
    onJobReleased({ job, opts: releaseOpts }) {
      void publishJobEvent(env, job, 'released', releaseToExtra(releaseOpts), opts, runtime)
    },
  }
}

export function createCfJobsBroadcastMetricsSink(
  env: CfJobsBroadcastEnv | undefined,
  opts: CfJobsBroadcastOptions = {},
): JobMetricsSink {
  return {
    record(event) {
      const data = jobEventFromMetrics(event)
      void publishMetricJobEvent(env, data, event, opts)
    },
  }
}

export function createCfJobsBroadcastBatchProgressHandler(
  env: CfJobsBroadcastEnv | undefined,
  opts: CfJobsBroadcastOptions = {},
): (progress: BatchProgress) => void {
  return (progress) => {
    const data: CfJobsBroadcastBatchProgressEvent = {
      batchId: progress.batchId,
      name: progress.name,
      completed: progress.completed,
      total: progress.total,
      failed: progress.failed,
      finishedAt: progress.finishedAt,
    }
    void publishBatchProgressEvent(env, data, progress, opts)
  }
}

function resolveCfJobsBroadcastStub(
  env: CfJobsBroadcastEnv | undefined,
  opts: Pick<CfJobsBroadcastOptions, 'durableObjectBinding' | 'durableObjectName'>,
): CfJobsBroadcastDurableObjectStub | null {
  const bindingName = opts.durableObjectBinding ?? DEFAULT_DO_BINDING
  const binding = env?.[bindingName] as CfJobsBroadcastDurableObjectNamespace | undefined
  if (!binding || typeof binding.idFromName !== 'function' || typeof binding.get !== 'function')
    return null
  const stub = binding.get(binding.idFromName(opts.durableObjectName ?? DEFAULT_DO_NAME))
  return stub && typeof stub.publish === 'function' ? stub : null
}

async function publishJobEvent<Queue extends string>(
  env: CfJobsBroadcastEnv | undefined,
  job: D1DurableJobRecord<Queue>,
  status: CfJobsBroadcastJobEvent['status'],
  extra: Partial<CfJobsBroadcastJobEvent>,
  opts: CfJobsBroadcastOptions,
  runtime: CfJobsBroadcastRuntimeOptions<any, any, any>,
): Promise<number> {
  const stored = parseStoredJobPayload(job.payload)
  const data: CfJobsBroadcastJobEvent = {
    jobName: stored.name,
    jobId: job.id,
    queue: job.queue,
    jobType: job.job_type,
    status,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    batchId: job.batch_id,
    ...extra,
  }

  const definition = stored.name ? await loadBroadcastJobDefinition(runtime.registry, stored.name) : undefined
  if (definition?.broadcast) {
    const messages = await definition.broadcast({
      env,
      ...data,
      jobName: stored.name!,
      maxAttempts: data.maxAttempts ?? null,
      payload: stored.payload,
    })
    return publishBroadcastMessages(env, messages, opts)
  }

  const channels = await channelsForJobEvent(data, job, opts)
  return publishCfJobsBroadcastMany(
    env,
    channels,
    `job.${status}`,
    data,
    opts,
  )
}

async function publishMetricJobEvent(
  env: CfJobsBroadcastEnv | undefined,
  data: CfJobsBroadcastJobEvent,
  event: JobMetricsEvent,
  opts: CfJobsBroadcastOptions,
): Promise<number> {
  const channels = await channelsForJobEvent(
    data,
    { id: event.jobId, queue: event.queue, batch_id: event.batchId },
    opts,
  )
  return publishCfJobsBroadcastMany(env, channels, `job.${event.status}`, data, opts)
}

async function publishBatchProgressEvent(
  env: CfJobsBroadcastEnv | undefined,
  data: CfJobsBroadcastBatchProgressEvent,
  progress: BatchProgress,
  opts: CfJobsBroadcastOptions,
): Promise<number> {
  const channels = await channelsForBatchProgress(data, progress, opts)
  return publishCfJobsBroadcastMany(env, channels, 'batch.progress', data, opts)
}

async function channelsForJobEvent(
  event: CfJobsBroadcastJobEvent,
  job: Pick<D1DurableJobRecord, 'id' | 'queue' | 'batch_id'>,
  opts: Pick<CfJobsBroadcastOptions, 'jobChannels'>,
): Promise<string[]> {
  return opts.jobChannels?.({ event, job }) ?? defaultJobChannels(job)
}

async function channelsForBatchProgress(
  event: CfJobsBroadcastBatchProgressEvent,
  progress: BatchProgress,
  opts: Pick<CfJobsBroadcastOptions, 'batchChannels'>,
): Promise<string[]> {
  return opts.batchChannels?.({ event, progress }) ?? defaultBatchChannels(progress)
}

function defaultJobChannels(job: Pick<D1DurableJobRecord, 'id' | 'queue' | 'batch_id'>): string[] {
  const channels = [cfJobChannel(job.id), cfJobQueueChannel(job.queue)]
  if (job.batch_id)
    channels.push(cfJobBatchChannel(job.batch_id))
  return channels
}

function defaultBatchChannels(progress: BatchProgress): string[] {
  return [cfJobBatchChannel(progress.batchId)]
}

function selectCompleteResult(
  job: D1DurableJobRecord,
  result: unknown,
  includeResult: CfJobsBroadcastOptions['includeResult'],
): unknown {
  if (includeResult === false)
    return undefined
  if (typeof includeResult === 'function')
    return includeResult({ job, result })
  return result
}

function releaseToExtra(opts: ReleaseDurableJobOptions | undefined): Partial<CfJobsBroadcastJobEvent> {
  return opts?.error ? { error: opts.error } : {}
}

function jobEventFromMetrics(event: JobMetricsEvent): CfJobsBroadcastJobEvent {
  // Narrow per outcome: only a completed run has stats + a result, and only a
  // failed/released one has an error. `cause` is never broadcast — it is an
  // arbitrary thrown object, and this payload is serialized to WebSocket clients.
  const completed = event.status === 'completed' ? event : undefined
  return {
    jobName: null,
    jobId: event.jobId,
    queue: event.queue,
    jobType: event.jobType,
    status: event.status,
    attempts: event.attempts,
    durationMs: event.durationMs,
    batchId: event.batchId,
    error: event.status === 'completed' ? undefined : event.error,
    rowsFetched: completed?.stats.rowsFetched,
    rowsInserted: completed?.stats.rowsInserted,
    d1RowsRead: completed?.stats.d1RowsRead,
    d1RowsWritten: completed?.stats.d1RowsWritten,
    result: completed?.result,
  }
}

async function loadBroadcastJobDefinition(
  registry: CfJobsBroadcastJobRegistry<any, any, any> | undefined,
  name: string,
): Promise<JobDefinition<string, any, string, any, any, any> | undefined> {
  return await registry?.loadJobDefinition?.(name) ?? registry?.getJobDefinition?.(name)
}

async function publishBroadcastMessages(
  env: CfJobsBroadcastEnv | undefined,
  input: Awaited<ReturnType<NonNullable<JobDefinition<string, any, string, any, any, any>['broadcast']>>>,
  opts: PublishOptions,
): Promise<number> {
  if (!input)
    return 0

  const messages = (Array.isArray(input) ? input : [input])
    .filter((message): message is CfJobsBroadcastMessage => !!message && typeof message === 'object')
  let sent = 0
  for (const message of messages) {
    const channels = normalizeCfJobsBroadcastChannels(message.channels ?? message.channel)
    if (!message.event || channels.length === 0)
      continue
    sent += await publishCfJobsBroadcastMany(env, channels, message.event, message.data, opts)
  }
  return sent
}

function parseStoredJobPayload(serialized: string): { name: string | null, payload: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(serialized) as Record<string, unknown>
    const name = typeof parsed._task === 'string' ? parsed._task : null
    const { _task, _continuations, ...payload } = parsed
    void _task
    void _continuations
    return { name, payload }
  }
  catch {
    return { name: null, payload: {} }
  }
}
