import { CF_JOBS_BROADCAST_TOPIC_PREFIX } from './broadcast-constants'

export { CF_JOBS_BROADCAST_DEFAULT_ROUTE, CF_JOBS_BROADCAST_SYSTEM_CHANNEL, CF_JOBS_BROADCAST_TOPIC_PREFIX } from './broadcast-constants'

export type CfJobsBroadcastJobStatus = 'claimed' | 'completed' | 'failed' | 'released'

export interface CfJobsBroadcastEnvelope<T = unknown> {
  channel: string
  event: string
  data: T
}

export interface CfJobsBroadcastMessage<T = unknown> {
  channel?: string
  channels?: string[]
  event: string
  data?: T
}

export interface CfJobsBroadcastJobEvent {
  jobName: string | null
  jobId: string
  queue: string
  jobType: string
  status: CfJobsBroadcastJobStatus
  attempts: number
  maxAttempts?: number | null
  durationMs?: number | null
  batchId: string | null
  error?: string
  result?: unknown
  rowsFetched?: number
  rowsInserted?: number
  d1RowsRead?: number
  d1RowsWritten?: number
}

export interface CfJobsBroadcastBatchProgressEvent {
  batchId: string
  name: string | null
  completed: number
  total: number
  failed: number
  finishedAt: number | null
}

export type CfJobsBroadcastClientCommand
  = | { event: 'subscribe', channels: string[] }
    | { event: 'unsubscribe', channels: string[] }
    | { event: 'ping' }

const CHANNEL_RE = /^[\w.:@/-]+$/

export function cfJobsChannel(scope: string, id: string | number): string {
  return `${scope}:${String(id)}`
}

export function cfJobChannel(jobId: string): string {
  return cfJobsChannel('job', jobId)
}

export function cfJobBatchChannel(batchId: string): string {
  return cfJobsChannel('batch', batchId)
}

export function cfJobQueueChannel(queue: string): string {
  return cfJobsChannel('queue', queue)
}

export function isCfJobsBroadcastChannel(channel: unknown): channel is string {
  return typeof channel === 'string'
    && channel.length > 0
    && channel.length <= 256
    && !channel.includes('..')
    && CHANNEL_RE.test(channel)
}

export function cfJobsBroadcastTopic(channel: string): string {
  if (!isCfJobsBroadcastChannel(channel))
    throw new Error(`Invalid cf-jobs broadcast channel: ${channel}`)
  return `${CF_JOBS_BROADCAST_TOPIC_PREFIX}${channel}`
}

export function normalizeCfJobsBroadcastChannels(input: unknown): string[] {
  const values = Array.isArray(input) ? input : [input]
  return [...new Set(values.filter(isCfJobsBroadcastChannel))]
}

export function parseCfJobsBroadcastCommand(input: unknown): CfJobsBroadcastClientCommand | null {
  const msg = typeof input === 'string'
    ? parseJsonObject(input)
    : input
  if (!msg || typeof msg !== 'object')
    return null

  const event = (msg as { event?: unknown, type?: unknown }).event ?? (msg as { type?: unknown }).type
  if (event === 'ping')
    return { event: 'ping' }
  if (event !== 'subscribe' && event !== 'unsubscribe')
    return null

  const channels = normalizeCfJobsBroadcastChannels(
    (msg as { channels?: unknown, channel?: unknown }).channels ?? (msg as { channel?: unknown }).channel,
  )
  if (channels.length === 0)
    return null
  return { event, channels }
}

function parseJsonObject(input: string): unknown {
  try {
    return JSON.parse(input)
  }
  catch {
    return null
  }
}
