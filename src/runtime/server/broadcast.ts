import type { CfJobsBroadcastBatchProgressEvent, CfJobsBroadcastJobEvent } from '../shared/broadcast'
import type { BatchProgress } from './batch'
import type { D1DurableJobRecord, D1DurableJobRepositoryOptions } from './d1'
import type { JobMetricsEvent, JobMetricsSink } from './metrics'
import type { ReleaseDurableJobOptions } from './outbox'
import {
  cfJobBatchChannel,
  cfJobChannel,
  cfJobQueueChannel,
  cfJobsBroadcastTopic,
  cfJobSiteChannel,
  cfJobUserChannel,
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
  cfJobSiteChannel,
  cfJobUserChannel,
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
} from '../shared/broadcast'

export interface CfJobsBroadcastDurableObjectStub {
  publish: (topic: string, data: unknown, opts?: { compress?: boolean }) => Promise<void>
}

export interface CfJobsBroadcastDurableObjectNamespace {
  idFromName: (name: string) => unknown
  get: (id: unknown) => CfJobsBroadcastDurableObjectStub
}

export interface CfJobsBroadcastEnv extends Record<string, unknown> {}

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
  /** Override fan-out channels for a job event. Defaults to job/batch/site/user/queue. */
  jobChannels?: (input: { event: CfJobsBroadcastJobEvent, job: Pick<D1DurableJobRecord, 'id' | 'queue' | 'batch_id' | 'site_id' | 'user_id'> }) => string[]
  /** Override fan-out channels for batch progress. Defaults to batch/site. */
  batchChannels?: (input: { event: CfJobsBroadcastBatchProgressEvent, progress: BatchProgress }) => string[]
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

export function createCfJobsBroadcastRepositoryHooks<Queue extends string = string>(
  env: CfJobsBroadcastEnv | undefined,
  opts: CfJobsBroadcastOptions = {},
): Pick<D1DurableJobRepositoryOptions<Queue>, 'onJobClaimed' | 'onJobCompleted' | 'onJobFailed' | 'onJobReleased'> {
  return {
    onJobClaimed({ job }) {
      void publishJobEvent(env, job, 'claimed', {}, opts)
    },
    onJobCompleted({ job, durationMs, result }) {
      const extra: Partial<CfJobsBroadcastJobEvent> = { durationMs }
      const selected = selectCompleteResult(job, result, opts.includeResult)
      if (selected !== undefined)
        extra.result = selected
      void publishJobEvent(env, job, 'completed', extra, opts)
    },
    onJobFailed({ job, error }) {
      void publishJobEvent(env, job, 'failed', { durationMs: job.duration_ms ?? null, error }, opts)
    },
    onJobReleased({ job, opts: releaseOpts }) {
      void publishJobEvent(env, job, 'released', releaseToExtra(releaseOpts), opts)
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
      void publishCfJobsBroadcastMany(
        env,
        channelsForJobEvent(data, { id: event.jobId, queue: event.queue, batch_id: event.batchId, site_id: event.siteId, user_id: event.userId }, opts),
        `job.${event.status}`,
        data,
        opts,
      )
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
      siteId: progress.siteId,
      completed: progress.completed,
      total: progress.total,
      failed: progress.failed,
      finishedAt: progress.finishedAt,
    }
    const channels = opts.batchChannels?.({ event: data, progress }) ?? defaultBatchChannels(progress)
    void publishCfJobsBroadcastMany(env, channels, 'batch.progress', data, opts)
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

function publishJobEvent<Queue extends string>(
  env: CfJobsBroadcastEnv | undefined,
  job: D1DurableJobRecord<Queue>,
  status: CfJobsBroadcastJobEvent['status'],
  extra: Partial<CfJobsBroadcastJobEvent>,
  opts: CfJobsBroadcastOptions,
): Promise<number> {
  const data: CfJobsBroadcastJobEvent = {
    jobId: job.id,
    queue: job.queue,
    jobType: job.job_type,
    status,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    batchId: job.batch_id,
    siteId: job.site_id,
    userId: job.user_id,
    ...extra,
  }
  return publishCfJobsBroadcastMany(
    env,
    channelsForJobEvent(data, job, opts),
    `job.${status}`,
    data,
    opts,
  )
}

function channelsForJobEvent(
  event: CfJobsBroadcastJobEvent,
  job: Pick<D1DurableJobRecord, 'id' | 'queue' | 'batch_id' | 'site_id' | 'user_id'>,
  opts: Pick<CfJobsBroadcastOptions, 'jobChannels'>,
): string[] {
  return opts.jobChannels?.({ event, job }) ?? defaultJobChannels(job)
}

function defaultJobChannels(job: Pick<D1DurableJobRecord, 'id' | 'queue' | 'batch_id' | 'site_id' | 'user_id'>): string[] {
  const channels = [cfJobChannel(job.id), cfJobQueueChannel(job.queue)]
  if (job.batch_id)
    channels.push(cfJobBatchChannel(job.batch_id))
  if (job.site_id)
    channels.push(cfJobSiteChannel(job.site_id))
  if (job.user_id != null)
    channels.push(cfJobUserChannel(job.user_id))
  return channels
}

function defaultBatchChannels(progress: BatchProgress): string[] {
  const channels = [cfJobBatchChannel(progress.batchId)]
  if (progress.siteId)
    channels.push(cfJobSiteChannel(progress.siteId))
  return channels
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
  return {
    jobId: event.jobId,
    queue: event.queue,
    jobType: event.jobType,
    status: event.status,
    attempts: event.attempts,
    durationMs: event.durationMs,
    batchId: event.batchId,
    siteId: event.siteId,
    userId: event.userId,
    error: event.error,
    rowsFetched: event.rowsFetched,
    rowsInserted: event.rowsInserted,
    d1RowsRead: event.d1RowsRead,
    d1RowsWritten: event.d1RowsWritten,
    result: event.result,
  }
}
