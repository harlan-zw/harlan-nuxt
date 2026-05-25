export interface QueueMessage<T = unknown> {
  body: T
  attempts: number
  ack: () => void
  retry: (opts?: { delaySeconds?: number }) => void
}

export interface QueueBatch<T = unknown> {
  queue: string
  messages: Array<QueueMessage<T>>
  ackAll?: () => void
  retryAll?: (opts?: { delaySeconds?: number }) => void
}

export interface QueuePayload<T = unknown, Env extends Record<string, unknown> = Record<string, unknown>> {
  batch: QueueBatch<T>
  env: Env
}

export interface CloudflareQueue<T = unknown> {
  send: (message: T, opts?: { delaySeconds?: number }) => Promise<void>
  sendBatch?: (messages: Array<{ body: T }>, opts?: { delaySeconds?: number }) => Promise<void>
}

export interface QueueBindingConfig {
  binding: string
  queueName?: string
  jobType?: string
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
  timeout?: number
  unique?: boolean
  uniqueFor?: number
  uniqueId?: (payload: Payload) => string
  skipUserRateLimit?: boolean
  rateLimit?: { perUser?: number, perSite?: number }
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
