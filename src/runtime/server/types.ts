export type QueueMessageContentType = 'text' | 'json' | 'bytes' | 'v8'

export interface QueueSendOptions {
  delaySeconds?: number
  contentType?: QueueMessageContentType
}

export interface QueueRetryOptions {
  delaySeconds?: number
}

export interface QueueMessage<T = unknown> {
  id?: string
  body: T
  attempts: number
  timestamp?: Date | number
  ack: () => void
  retry: (opts?: QueueRetryOptions) => void
}

export interface QueueBatch<T = unknown> {
  queue: string
  messages: Array<QueueMessage<T>>
  ackAll?: () => void
  retryAll?: (opts?: QueueRetryOptions) => void
}

export interface QueuePayload<T = unknown, Env extends Record<string, unknown> = Record<string, unknown>> {
  batch: QueueBatch<T>
  env: Env
}

export interface CloudflareQueueSendBatchMessage<T = unknown> {
  body: T
  contentType?: QueueMessageContentType
  delaySeconds?: number
}

export interface CloudflareQueue<T = unknown> {
  send: (message: T, opts?: QueueSendOptions) => Promise<void>
  sendBatch?: (messages: Array<CloudflareQueueSendBatchMessage<T>>, opts?: QueueSendOptions) => Promise<void>
}

export interface QueueBindingConfig {
  binding: string
  queueName?: string
  jobType?: string
  /** Wrangler `[[queues.consumers]].max_batch_size` (informational; validated against handler expectations). */
  maxBatchSize?: number
  /** Wrangler `[[queues.consumers]].max_batch_timeout` in seconds. */
  maxBatchTimeout?: number
  /** Wrangler `[[queues.consumers]].max_concurrency`. */
  maxConcurrency?: number
  /** Wrangler `[[queues.consumers]].max_retries`. Compared against `definition.tries`. */
  maxRetries?: number
  /** Wrangler `[[queues.consumers]].retry_delay` in seconds (default retry delay if none supplied per-message). */
  retryDelay?: number
  /** Wrangler `[[queues.consumers]].dead_letter_queue` — the *Cloudflare* queue name. */
  deadLetterQueue?: string
  /** Binding name of the DLQ producer, used when this module manually forwards exhausted messages. */
  deadLetterQueueBinding?: string
}

export type QueueBindingsConfig = Record<string, string | QueueBindingConfig>

export interface JobControlResult {
  handled: boolean
  action?: 'released' | 'failed'
  delaySeconds?: number
  error?: string
}

export interface JobContext<Env, Db, Logger> {
  env: Env
  jobId: string
  batchId: string | null
  attempt: number
  db: Db
  log: Logger
  release: (delaySeconds: number) => Promise<void>
  fail: (error: string) => Promise<void>
}

export type JobHandler<Payload, Env, Db, Logger> = (
  payload: Payload,
  ctx: JobContext<Env, Db, Logger>,
) => Promise<void>

export type JobFailedHandler<Payload, Env, Db, Logger> = (
  payload: Payload,
  ctx: JobContext<Env, Db, Logger>,
  error: unknown,
) => Promise<void>

export type JobNext = () => Promise<void>

export type JobMiddleware<Payload, Env, Db, Logger> = (
  payload: Payload,
  ctx: JobContext<Env, Db, Logger>,
  next: JobNext,
) => Promise<void>

export type JobBackoff = number | number[] | ((attempt: number) => number)

export type JobPayloadParseResult<Payload>
  = | { success: true, data: Payload }
    | { success: false, error: unknown }

export interface JobPayloadSchema<Payload> {
  safeParse: (payload: unknown) => JobPayloadParseResult<Payload>
}

export interface JobDefinition<Name extends string, Payload, Queue extends string, Env, Db, Logger> {
  name: Name
  queue: Queue
  jobType?: string
  input?: JobPayloadSchema<Payload>
  handle: JobHandler<Payload, Env, Db, Logger>
  failed?: JobFailedHandler<Payload, Env, Db, Logger>
  middleware?: Array<JobMiddleware<Payload, Env, Db, Logger>>
  tries?: number
  maxAttempts?: number
  backoff?: JobBackoff
  unique?: boolean
  uniqueId?: (payload: Payload) => string
}

export interface DispatchableJob<Payload = Record<string, unknown>> {
  id: string
  queue: string
  payload: Payload
  attempts: number
  batchId: string | null
  siteId?: string | null
  userId?: number | null
}

export interface DispatchResult {
  success: boolean
  error?: string
  handlerNotFound?: boolean
  invalidPayload?: boolean
  validationError?: unknown
  control?: JobControlResult
}

export type QueueHandlerResult = { action: 'ack' } | { action: 'retry', delaySeconds?: number }
