import type { JobRegistryLike } from './dispatch'
import type { DurableJobFailureRepository } from './outbox'
import type { AnyJobDefinition, JobMessageOf, JobPayloadOf } from './registry'
import type { QueueSource } from './runtime-env'
import type { CloudflareQueue, CloudflareQueueSendBatchMessage, DispatchableJob, JobContext, JobControlResult, JobDefinition, QueueBindingsConfig, QueueMessageContentType, QueuePayload, QueueSendBatchOptions, QueueSendOptions } from './types'
import { runtimeConfigSource } from '@harlan-zw/nuxt-cloudflare/bindings'
import { dispatchRegisteredJob } from './dispatch'
import { formatJobError } from './errors'
import { CF_QUEUE_MAX_DELAY_SECONDS, stableStringify } from './internal'
import { createObjectMessageDedup } from './message-dedup'
import { clampDelay, resolveJobMaxAttempts, resolveJobRetryDelay } from './policy'
import { buildJobMessage, parseJobInput } from './registry'
import { resolveQueueSourceEnv } from './runtime-env'

export { CF_QUEUE_MAX_DELAY_SECONDS } from './internal'

export const CF_QUEUE_MAX_BATCH_SIZE = 100
export const CF_QUEUE_MAX_BATCH_BYTES = 256_000
export const CF_QUEUE_MAX_MESSAGE_BYTES = 128_000
const CF_QUEUE_MESSAGE_METADATA_BYTES = 100
const TRANSIENT_QUEUE_ERROR_RE = /\b(?:429|rate limit|too many requests|backpressure)\b/i

function utf8ByteLength(value: string): number {
  return typeof Buffer !== 'undefined' ? Buffer.byteLength(value, 'utf8') : new TextEncoder().encode(value).byteLength
}

function estimateQueueMessageBytes(message: CloudflareQueueSendBatchMessage<unknown>): number | undefined {
  let bodyBytes: number | undefined
  switch (message.contentType ?? 'json') {
    case 'bytes':
      if (message.body instanceof ArrayBuffer)
        bodyBytes = message.body.byteLength
      else if (ArrayBuffer.isView(message.body))
        bodyBytes = message.body.byteLength
      break
    case 'text':
      if (typeof message.body === 'string')
        bodyBytes = utf8ByteLength(message.body)
      break
    case 'json': {
      try {
        const serialized = JSON.stringify(message.body)
        if (serialized !== undefined)
          bodyBytes = utf8ByteLength(serialized)
      }
      catch {
        // Let the platform report invalid JSON payloads. They cannot be safely
        // size-estimated here, so isolate them in their own sendBatch call.
      }
      break
    }
    case 'v8':
      // V8 structured-clone byte size is not exposed in Workers. A singleton
      // batch still respects the 256 KB batch cap whenever the 128 KB item cap is met.
      break
  }
  return bodyBytes === undefined ? undefined : bodyBytes + CF_QUEUE_MESSAGE_METADATA_BYTES
}

function chunkQueueBatchMessages<T>(
  messages: readonly CloudflareQueueSendBatchMessage<T>[],
): Array<Array<CloudflareQueueSendBatchMessage<T>>> {
  const chunks: Array<Array<CloudflareQueueSendBatchMessage<T>>> = []
  let current: Array<CloudflareQueueSendBatchMessage<T>> = []
  let currentBytes = 0

  const flush = () => {
    if (current.length > 0)
      chunks.push(current)
    current = []
    currentBytes = 0
  }

  for (const message of messages) {
    const bytes = estimateQueueMessageBytes(message)
    if (bytes !== undefined && bytes > CF_QUEUE_MAX_MESSAGE_BYTES) {
      throw new RangeError(
        `Cloudflare Queue message is approximately ${bytes} bytes; the maximum is ${CF_QUEUE_MAX_MESSAGE_BYTES} bytes including metadata`,
      )
    }

    // Unknown structured-clone sizes get a singleton call. This prevents an
    // otherwise valid V8 message from pushing a mixed batch over 256 KB.
    if (bytes === undefined) {
      flush()
      chunks.push([message])
      continue
    }

    if (current.length >= CF_QUEUE_MAX_BATCH_SIZE || currentBytes + bytes > CF_QUEUE_MAX_BATCH_BYTES)
      flush()
    current.push(message)
    currentBytes += bytes
  }
  flush()
  return chunks
}

export interface SendBackpressureOptions {
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  onError?: (input: { error: unknown, attempt: number, willRetry: boolean }) => void | Promise<void>
}

function isTransientQueueError(error: unknown): boolean {
  const code = (error as { status?: number, code?: number, statusCode?: number } | null)?.status
    ?? (error as { code?: number } | null)?.code
    ?? (error as { statusCode?: number } | null)?.statusCode
  if (code === 429 || code === 503 || code === 502 || code === 500)
    return true
  const message = (error as { message?: string } | null)?.message ?? ''
  return TRANSIENT_QUEUE_ERROR_RE.test(message)
}

export async function withSendBackpressure<R>(
  fn: () => Promise<R>,
  opts: SendBackpressureOptions | undefined,
): Promise<R> {
  const max = opts?.maxRetries ?? 5
  const base = opts?.baseDelayMs ?? 100
  const cap = opts?.maxDelayMs ?? 5000
  let attempt = 0

  while (true) {
    try {
      return await fn()
    }
    catch (error) {
      const willRetry = attempt < max && isTransientQueueError(error)
      await opts?.onError?.({ error, attempt: attempt + 1, willRetry })
      if (!willRetry)
        throw error
      const delay = Math.min(cap, base * 2 ** attempt) * (0.5 + Math.random())
      await new Promise(resolve => setTimeout(resolve, delay))
      attempt++
    }
  }
}

export async function sendBatchChunked<T>(
  cfQueue: CloudflareQueue<T>,
  messages: T[],
  opts?: QueueSendOptions & SendBackpressureOptions,
): Promise<void> {
  const sendOpts: QueueSendOptions | undefined = opts && (opts.delaySeconds !== undefined || opts.contentType !== undefined)
    ? { delaySeconds: opts.delaySeconds, contentType: opts.contentType }
    : undefined
  const batchOpts: QueueSendBatchOptions | undefined = opts?.delaySeconds === undefined
    ? undefined
    : { delaySeconds: opts.delaySeconds }
  const batchMessages: Array<CloudflareQueueSendBatchMessage<T>> = messages.map(body => ({
    body,
    ...(opts?.contentType === undefined ? {} : { contentType: opts.contentType }),
  }))
  for (const slice of chunkQueueBatchMessages(batchMessages)) {
    if (typeof cfQueue.sendBatch === 'function') {
      await withSendBackpressure(
        () => cfQueue.sendBatch!(slice, batchOpts),
        opts,
      )
    }
    else {
      await Promise.all(slice.map(message => withSendBackpressure(() => cfQueue.send(message.body, sendOpts), opts)))
    }
  }
}

export async function sendBatchMessagesChunked<T>(
  cfQueue: CloudflareQueue<T>,
  messages: Array<CloudflareQueueSendBatchMessage<T>>,
  opts?: SendBackpressureOptions,
): Promise<void> {
  for (const slice of chunkQueueBatchMessages(messages)) {
    if (typeof cfQueue.sendBatch === 'function') {
      await withSendBackpressure(() => cfQueue.sendBatch!(slice), opts)
    }
    else {
      await Promise.all(slice.map(message => withSendBackpressure(
        () => cfQueue.send(message.body, { delaySeconds: message.delaySeconds, contentType: message.contentType }),
        opts,
      )))
    }
  }
}

export interface JobQueuePublisher<Job extends AnyJobDefinition> {
  send: (payload: JobPayloadOf<Job>, opts?: QueueSendOptions & SendBackpressureOptions) => Promise<boolean>
  sendBatch: (payloads: Array<JobPayloadOf<Job>>, opts?: QueueSendOptions & SendBackpressureOptions) => Promise<boolean>
  sendBatchMessages: (
    messages: Array<{ payload: JobPayloadOf<Job>, delaySeconds?: number, contentType?: QueueMessageContentType }>,
    opts?: SendBackpressureOptions,
  ) => Promise<boolean>
}

export type QueueBindingUnavailableReason = 'missing-config' | 'missing-env' | 'missing-env-binding' | 'invalid-binding'

export interface QueueBindingUnavailableInput<Job extends AnyJobDefinition = AnyJobDefinition> {
  job: Pick<Job, 'name' | 'queue'>
  queue: string
  binding?: string
  reason: QueueBindingUnavailableReason
  count: number
}

export interface JobQueuePublisherOptions<Job extends AnyJobDefinition = AnyJobDefinition> {
  onUnavailable?: (input: QueueBindingUnavailableInput<Job>) => void | Promise<void>
}

export interface QueueBindingValidationIssue {
  jobName: string
  queue: string
  reason: 'missing-binding'
}

export function validateJobQueueBindings(
  queues: QueueBindingsConfig,
  jobs: readonly Pick<AnyJobDefinition, 'name' | 'queue'>[],
): QueueBindingValidationIssue[] {
  const issues: QueueBindingValidationIssue[] = []
  for (const job of jobs) {
    if (!resolveQueueBindingName(queues, job.queue)) {
      issues.push({
        jobName: job.name,
        queue: job.queue,
        reason: 'missing-binding',
      })
    }
  }
  return issues
}

export function assertJobQueueBindings(
  queues: QueueBindingsConfig,
  jobs: readonly Pick<AnyJobDefinition, 'name' | 'queue'>[],
): void {
  const issues = validateJobQueueBindings(queues, jobs)
  if (issues.length === 0)
    return

  const details = issues
    .map(issue => `${issue.jobName} -> ${issue.queue}`)
    .join(', ')
  throw new Error(`Missing Cloudflare queue bindings for jobs: ${details}`)
}

export function createJobQueue<const Job extends AnyJobDefinition>(
  source: QueueSource | undefined,
  queues: QueueBindingsConfig,
  definition: Job,
  publisherOpts: JobQueuePublisherOptions<Job> = {},
): JobQueuePublisher<Job> {
  const env = resolveQueueSourceEnv(source)

  function resolveQueue(): { queue: CloudflareQueue<JobMessageOf<Job>> } | { reason: QueueBindingUnavailableReason, binding?: string } {
    const binding = resolveQueueBindingName(queues, definition.queue)
    if (!binding)
      return { reason: 'missing-config' }
    if (!env)
      return { reason: 'missing-env', binding }
    const queue = env[binding] as CloudflareQueue<JobMessageOf<Job>> | undefined
    if (!queue)
      return { reason: 'missing-env-binding', binding }
    if (typeof queue.send !== 'function')
      return { reason: 'invalid-binding', binding }
    return { queue }
  }

  async function getQueue(count: number): Promise<CloudflareQueue<JobMessageOf<Job>> | undefined> {
    const resolved = resolveQueue()
    if ('queue' in resolved)
      return resolved.queue

    await publisherOpts.onUnavailable?.({
      job: definition,
      queue: definition.queue,
      binding: resolved.binding,
      reason: resolved.reason,
      count,
    })
    return undefined
  }

  return {
    async send(payload, opts) {
      const queue = await getQueue(1)
      if (!queue)
        return false

      const sendOpts: QueueSendOptions | undefined = opts && (opts.delaySeconds !== undefined || opts.contentType !== undefined)
        ? { delaySeconds: opts.delaySeconds, contentType: opts.contentType }
        : undefined
      await withSendBackpressure(() => queue.send(buildJobMessage(definition, payload), sendOpts), opts)
      return true
    },
    async sendBatch(payloads, opts) {
      if (payloads.length === 0)
        return true

      const queue = await getQueue(payloads.length)
      if (!queue)
        return false

      const messages = payloads.map(payload => buildJobMessage(definition, payload))
      await sendBatchChunked(queue, messages, opts)
      return true
    },
    async sendBatchMessages(messages, opts) {
      if (messages.length === 0)
        return true

      const queue = await getQueue(messages.length)
      if (!queue)
        return false

      const batch: Array<CloudflareQueueSendBatchMessage<JobMessageOf<Job>>> = messages.map(m => ({
        body: buildJobMessage(definition, m.payload),
        delaySeconds: m.delaySeconds,
        contentType: m.contentType,
      }))
      await sendBatchMessagesChunked(queue, batch, opts)
      return true
    },
  }
}

export function resolveQueueBindingName(
  queues: QueueBindingsConfig,
  queueName: string,
): string | undefined {
  const config = queues[queueName]
  return typeof config === 'string' ? config : config?.binding
}

export function resolveCloudflareQueueName(
  queues: QueueBindingsConfig,
  queueName: string,
): string {
  const config = queues[queueName]
  return typeof config === 'string' ? queueName : config?.queueName ?? queueName
}

export function resolveLogicalQueueName(
  queues: QueueBindingsConfig,
  cloudflareQueueName: string,
): string | undefined {
  for (const [logicalName, config] of Object.entries(queues)) {
    if (resolveCloudflareQueueName(queues, logicalName) === cloudflareQueueName)
      return logicalName
    if (typeof config === 'string' && logicalName === cloudflareQueueName)
      return logicalName
  }
}

export function resolveQueueJobType(
  queues: QueueBindingsConfig,
  queueName: string,
): string | undefined {
  const config = queues[queueName]
  return typeof config === 'string' ? undefined : config?.jobType
}

export function getQueueBinding<T>(
  env: Record<string, unknown> | undefined,
  binding: string | undefined,
): CloudflareQueue<T> | undefined {
  if (!binding)
    return undefined
  const queue = env?.[binding] as CloudflareQueue<T> | undefined
  return queue && typeof queue.send === 'function' ? queue : undefined
}

export function getQueueBindingByName<T>(
  env: Record<string, unknown> | undefined,
  queues: QueueBindingsConfig,
  queueName: string,
): CloudflareQueue<T> | undefined {
  const binding = resolveQueueBindingName(queues, queueName)
  return binding ? getQueueBinding<T>(env, binding) : undefined
}

export async function sendQueueMessage<T>(
  env: Record<string, unknown> | undefined,
  binding: string,
  message: T,
  opts?: QueueSendOptions & SendBackpressureOptions,
): Promise<boolean> {
  const queue = getQueueBinding<T>(env, binding)
  if (!queue)
    return false
  const sendOpts: QueueSendOptions | undefined = opts && (opts.delaySeconds !== undefined || opts.contentType !== undefined)
    ? { delaySeconds: opts.delaySeconds, contentType: opts.contentType }
    : undefined
  await withSendBackpressure(() => queue.send(message, sendOpts), opts)
  return true
}

export async function sendQueueBatch<T>(
  env: Record<string, unknown> | undefined,
  binding: string,
  messages: T[],
  opts?: QueueSendOptions & SendBackpressureOptions,
): Promise<boolean> {
  if (messages.length === 0)
    return true
  const queue = getQueueBinding<T>(env, binding)
  if (!queue)
    return false
  await sendBatchChunked(queue, messages, opts)
  return true
}

export async function sendNamedQueueMessage<T>(
  env: Record<string, unknown> | undefined,
  queues: QueueBindingsConfig,
  queueName: string,
  message: T,
  opts?: QueueSendOptions & SendBackpressureOptions,
): Promise<boolean> {
  return sendQueueMessage(env, resolveQueueBindingName(queues, queueName) ?? '', message, opts)
}

export async function sendNamedQueueBatch<T>(
  env: Record<string, unknown> | undefined,
  queues: QueueBindingsConfig,
  queueName: string,
  messages: T[],
  opts?: QueueSendOptions & SendBackpressureOptions,
): Promise<boolean> {
  return sendQueueBatch(env, resolveQueueBindingName(queues, queueName) ?? '', messages, opts)
}

export interface DlqPublisher<T = Record<string, unknown>> {
  send: (message: T, opts?: QueueSendOptions & SendBackpressureOptions) => Promise<boolean>
}

export function createDlqPublisher<T = Record<string, unknown>, Env extends Record<string, unknown> = Record<string, unknown>>(
  env: Env | undefined,
  binding: string,
): DlqPublisher<T> {
  return {
    async send(message, opts) {
      return sendQueueMessage(env, binding, message, opts)
    },
  }
}

export function shouldSendToDlq(input: { attempts: number, maxAttempts?: number }): boolean {
  return input.maxAttempts !== undefined && input.attempts >= input.maxAttempts
}

export function resolveDlqBinding(
  queues: QueueBindingsConfig,
  logicalQueue: string,
): string | undefined {
  const config = queues[logicalQueue]
  if (typeof config !== 'object' || !config)
    return undefined
  if (config.deadLetterQueueBinding)
    return config.deadLetterQueueBinding
  // Fall back: look up a binding whose CF queue name matches deadLetterQueue
  if (config.deadLetterQueue) {
    for (const [name, c] of Object.entries(queues)) {
      const cfName = resolveCloudflareQueueName(queues, name)
      if (cfName === config.deadLetterQueue)
        return typeof c === 'string' ? c : c?.binding
    }
  }
  return undefined
}

export interface QueueConsumerConfigIssue {
  queue: string
  jobName?: string
  reason: 'tries-exceeds-max-retries' | 'dlq-binding-missing'
  detail: string
}

export function validateQueueConsumerConfig(
  queues: QueueBindingsConfig,
  jobs: readonly AnyJobDefinition[],
): QueueConsumerConfigIssue[] {
  const issues: QueueConsumerConfigIssue[] = []
  for (const job of jobs) {
    const config = queues[job.queue]
    if (!config || typeof config === 'string')
      continue
    const tries = resolveJobMaxAttempts(job)
    if (config.maxRetries !== undefined && tries !== undefined && tries > config.maxRetries + 1) {
      issues.push({
        queue: job.queue,
        jobName: job.name,
        reason: 'tries-exceeds-max-retries',
        detail: `job.tries=${tries} exceeds wrangler max_retries=${config.maxRetries} (allows ${config.maxRetries + 1} total deliveries)`,
      })
    }
    if (config.deadLetterQueue && !resolveDlqBinding(queues, job.queue)) {
      issues.push({
        queue: job.queue,
        jobName: job.name,
        reason: 'dlq-binding-missing',
        detail: `dead_letter_queue="${config.deadLetterQueue}" has no producer binding (set deadLetterQueueBinding or add a queues entry whose queueName matches)`,
      })
    }
  }
  return issues
}

export interface QueueShapeIssue {
  queue: string
  reason: 'missing-binding' | 'dlq-pair-incomplete' | 'duplicate-binding' | 'duplicate-cf-queue-name'
  detail: string
}

export function validateQueueBindingShape(queues: QueueBindingsConfig): QueueShapeIssue[] {
  const issues: QueueShapeIssue[] = []
  const seenBindings = new Map<string, string>()
  const seenCfNames = new Map<string, string>()

  for (const [logical, config] of Object.entries(queues)) {
    if (!config) {
      issues.push({ queue: logical, reason: 'missing-binding', detail: 'queue entry is empty' })
      continue
    }
    const binding = typeof config === 'string' ? config : config.binding
    if (!binding) {
      issues.push({ queue: logical, reason: 'missing-binding', detail: 'no Cloudflare binding name' })
      continue
    }
    const prevBinding = seenBindings.get(binding)
    if (prevBinding && prevBinding !== logical) {
      issues.push({
        queue: logical,
        reason: 'duplicate-binding',
        detail: `binding "${binding}" also used by logical queue "${prevBinding}"`,
      })
    }
    else {
      seenBindings.set(binding, logical)
    }

    const cfName = resolveCloudflareQueueName(queues, logical)
    const prevCf = seenCfNames.get(cfName)
    if (prevCf && prevCf !== logical) {
      issues.push({
        queue: logical,
        reason: 'duplicate-cf-queue-name',
        detail: `Cloudflare queue "${cfName}" also used by logical queue "${prevCf}"`,
      })
    }
    else {
      seenCfNames.set(cfName, logical)
    }

    if (typeof config === 'object') {
      const hasDlq = !!config.deadLetterQueue
      const hasBinding = !!config.deadLetterQueueBinding
      if (hasDlq !== hasBinding) {
        issues.push({
          queue: logical,
          reason: 'dlq-pair-incomplete',
          detail: hasDlq
            ? `deadLetterQueue="${config.deadLetterQueue}" set without deadLetterQueueBinding (module cannot forward exhausted messages)`
            : `deadLetterQueueBinding="${config.deadLetterQueueBinding}" set without deadLetterQueue (wrangler consumer config won't reference the DLQ)`,
        })
      }
    }
  }

  return issues
}

/**
 * Identity helper that pins the literal types of a queues config and runs structural validation eagerly.
 * Throws on shape issues (duplicate bindings, half-configured DLQ pairs) so misconfig fails fast.
 *
 * @example
 *   export const queues = defineCfJobsQueues({
 *     default: 'QUEUE_DEFAULT',
 *     critical: { binding: 'QUEUE_CRITICAL', queueName: 'critical-prod', maxRetries: 5 },
 *   } as const)
 */
export function defineCfJobsQueues<const T extends QueueBindingsConfig>(queues: T): T {
  const issues = validateQueueBindingShape(queues)
  if (issues.length > 0) {
    const details = issues.map(i => `  - ${i.queue} (${i.reason}): ${i.detail}`).join('\n')
    throw new Error(`Invalid nuxt-cf-jobs queues config:\n${details}`)
  }
  return queues
}

export function registerQueueConsumer<T, Env extends Record<string, unknown>>(
  nitroApp: { hooks: { hook: (name: any, handler: any) => void } },
  queueName: string,
  handler: (payload: QueuePayload<T, Env>) => Promise<void>,
  queues?: QueueBindingsConfig,
) {
  nitroApp.hooks.hook('cloudflare:queue', async (payload: QueuePayload<T, Env>) => {
    const cfQueue = payload.batch.queue
    const matchesCfName = cfQueue === queueName
    const matchesLogical = queues ? resolveCloudflareQueueName(queues, queueName) === cfQueue : false
    if (matchesCfName || matchesLogical)
      await handler(payload)
  })
}

export interface RegisteredQueueConsumerMessage<T = Record<string, unknown>> {
  id?: string
  body: T
  attempts: number
  timestamp?: Date | number
  ack: () => void
  retry: (opts?: { delaySeconds?: number }) => void
}

export interface RegisteredQueueConsumerBatch<T = Record<string, unknown>> {
  queue: string
  messages: Array<RegisteredQueueConsumerMessage<T>>
  ackAll?: () => void
  retryAll?: (opts?: { delaySeconds?: number }) => void
}

export interface RegisteredQueueConsumerPayload<Env extends Record<string, unknown>> {
  batch: RegisteredQueueConsumerBatch
  env: Env
}

export interface DlqMessageInput<Env extends Record<string, unknown>> {
  env: Env
  batch: RegisteredQueueConsumerBatch
  message: RegisteredQueueConsumerMessage
  /** Parsed `_task` from the message body, when present. */
  taskName?: string
  /** Parsed `jobId` from the message body, when present. */
  jobId?: string
}

export interface DlqQueueHandler<Env extends Record<string, unknown>> {
  /** When true, the message is persisted via `dlqRepository.recordFailure` (if configured). */
  persist?: boolean
  /** Custom per-message handler. Runs after `persist` (if enabled). Errors are propagated. */
  onMessage?: (input: DlqMessageInput<Env>) => void | Promise<void>
}

export type DlqQueuesOption<Env extends Record<string, unknown>>
  = | readonly string[]
    | ((cfQueueName: string) => boolean)
    | Record<string, DlqQueueHandler<Env>>

export interface RegisteredQueueConsumerContextInput<Env extends Record<string, unknown>> {
  env: Env
  batch: RegisteredQueueConsumerBatch
  message: RegisteredQueueConsumerMessage
  logicalQueue: string
  taskName: string
  definition: JobDefinition<string, unknown, string, Env, unknown, unknown>
  job: DispatchableJob
  control: JobControlResult
  payload: Record<string, unknown>
}

export interface RegisteredQueueConsumerHookInput<Env extends Record<string, unknown>> {
  env: Env
  batch: RegisteredQueueConsumerBatch
  message: RegisteredQueueConsumerMessage
  logicalQueue?: string
  taskName?: string
  definition?: AnyJobDefinition
  job?: DispatchableJob
}

export interface RegisterRegisteredQueueConsumerOptions<Env extends Record<string, unknown>, Db, Logger> {
  registry: JobRegistryLike<Env, Db, Logger> & { jobs?: readonly AnyJobDefinition[] }
  queues: QueueBindingsConfig | ((source?: QueueSource) => QueueBindingsConfig)
  createContext: (input: RegisteredQueueConsumerContextInput<Env>) => JobContext<Env, Db, Logger> | Promise<JobContext<Env, Db, Logger>>
  getJobId?: (input: RegisteredQueueConsumerHookInput<Env> & { payload: Record<string, unknown> }) => string
  getSiteId?: (payload: Record<string, unknown>) => string | null | undefined
  getUserId?: (payload: Record<string, unknown>) => number | null | undefined
  retryDelaySeconds?: (input: RegisteredQueueConsumerHookInput<Env> & { error: unknown }) => number
  dlqQueues?: DlqQueuesOption<Env>
  /** Forward exhausted messages to a DLQ. If unspecified, falls back to the binding resolved from `queues[logical].deadLetterQueueBinding`/`deadLetterQueue`. */
  dlqBinding?: string | ((input: { logicalQueue: string, definition?: AnyJobDefinition }) => string | undefined)
  /**
   * Repository used to persist exhausted DLQ messages when `dlqQueues` is set to the
   * `Record<string, { persist: true }>` form. Cloudflare's wrangler `dead_letter_queue` directive
   * only forwards messages CF-side; you still need a `cloudflare:queue` consumer for the DLQ to
   * persist them, which this option provides.
   */
  dlqRepository?: DurableJobFailureRepository
  /** Delay (s) applied when unknown-queue messages are returned to the queue. Defaults to 60. */
  unknownQueueRetryDelaySeconds?: number
  /** In-memory dedup cache size for the lightweight (non-durable) consumer path. Set to 0 to disable. */
  dedupCacheSize?: number
  /**
   * Write a `cfjob:<name>` line before each handler runs.
   *
   * A Cloudflare queue trace names the QUEUE, not the job, so a consumer that
   * carries many job kinds reports every failure — including the memory kills
   * that flush nothing else — against one bucket. This marker is what lets a
   * Tail Worker recover the job name. Off by default; it costs one log line per
   * message. See `trace-marker.ts`.
   */
  traceMarker?: boolean
  onMissingQueue?: (input: RegisteredQueueConsumerHookInput<Env>) => void | Promise<void>
  onInvalidPayload?: (input: RegisteredQueueConsumerHookInput<Env> & { error?: string, validationError?: unknown }) => void | Promise<void>
  onDispatchError?: (input: RegisteredQueueConsumerHookInput<Env> & { error: unknown }) => void | Promise<void>
  onDlq?: (input: RegisteredQueueConsumerHookInput<Env>) => void | Promise<void>
  onDuplicate?: (input: RegisteredQueueConsumerHookInput<Env>) => void | Promise<void>
}

export function registerRegisteredQueueConsumer<Env extends Record<string, unknown>, Db, Logger>(
  nitroApp: { hooks: { hook: (name: any, handler: any) => void } },
  opts: RegisterRegisteredQueueConsumerOptions<Env, Db, Logger>,
) {
  nitroApp.hooks.hook('cloudflare:queue', async (payload: RegisteredQueueConsumerPayload<Env>) => processRegisteredQueueBatch(payload, opts))
}

export async function processRegisteredQueueBatch<Env extends Record<string, unknown>, Db, Logger>(
  payload: RegisteredQueueConsumerPayload<Env>,
  opts: RegisterRegisteredQueueConsumerOptions<Env, Db, Logger>,
) {
  const queues = typeof opts.queues === 'function' ? opts.queues(runtimeConfigSource(payload.env)) : opts.queues
  const logicalQueue = resolveLogicalQueueName(queues, payload.batch.queue)
  const unknownDelay = clampDelay(opts.unknownQueueRetryDelaySeconds ?? 60) ?? 60

  if (!logicalQueue) {
    if (isDlqQueue(payload.batch.queue, opts.dlqQueues)) {
      const handler = resolveDlqHandler(payload.batch.queue, opts.dlqQueues)
      for (const message of payload.batch.messages) {
        const body = isRecord(message.body) ? message.body : {}
        const taskName = typeof body._task === 'string' ? body._task : undefined
        const jobId = typeof body.jobId === 'string' ? body.jobId : undefined
        const dlqInput: DlqMessageInput<typeof payload.env> = { env: payload.env, batch: payload.batch, message, taskName, jobId }
        if (handler?.persist) {
          if (!opts.dlqRepository)
            throw new Error(`DLQ queue "${payload.batch.queue}" has persist:true but requires dlqRepository`)
          const definition = taskName ? opts.registry.getJobDefinition?.(taskName) : undefined
          try {
            await opts.dlqRepository.recordFailure({
              id: jobId,
              queue: definition?.queue ?? payload.batch.queue,
              jobType: definition?.jobType ?? taskName ?? payload.batch.queue,
              payload: typeof message.body === 'string' ? message.body : JSON.stringify(message.body),
              exception: `[DLQ ${payload.batch.queue}]`,
              attempts: message.attempts,
            })
          }
          catch (error) {
            await reportRegisteredQueueError(opts, { env: payload.env, batch: payload.batch, message, error })
            throw error
          }
        }
        await handler?.onMessage?.(dlqInput)
        await opts.onDlq?.(dlqInput)
      }
      if (typeof payload.batch.ackAll === 'function') {
        payload.batch.ackAll()
      }
      else {
        for (const message of payload.batch.messages) message.ack()
      }
      return
    }
    // Unknown queue but not configured as DLQ: don't silently drop — return to queue.
    await opts.onMissingQueue?.({ env: payload.env, batch: payload.batch, message: payload.batch.messages[0]! })
    if (typeof payload.batch.retryAll === 'function') {
      payload.batch.retryAll({ delaySeconds: unknownDelay })
    }
    else {
      for (const message of payload.batch.messages) message.retry({ delaySeconds: unknownDelay })
    }
    return
  }

  if (opts.registry.jobs && !opts.registry.jobs.some(job => job.queue === logicalQueue)) {
    await opts.onMissingQueue?.({ env: payload.env, batch: payload.batch, message: payload.batch.messages[0]!, logicalQueue })
    if (typeof payload.batch.retryAll === 'function') {
      payload.batch.retryAll({ delaySeconds: unknownDelay })
    }
    else {
      for (const message of payload.batch.messages) message.retry({ delaySeconds: unknownDelay })
    }
    return
  }

  for (const message of payload.batch.messages)
    await processRegisteredQueueMessage({ env: payload.env, batch: payload.batch, message, logicalQueue }, opts)
}

async function processRegisteredQueueMessage<Env extends Record<string, unknown>, Db, Logger>(
  input: RegisteredQueueConsumerHookInput<Env> & { logicalQueue: string, message: RegisteredQueueConsumerMessage },
  opts: RegisterRegisteredQueueConsumerOptions<Env, Db, Logger>,
) {
  const payload = isRecord(input.message.body) ? input.message.body : {}
  const taskName = typeof payload._task === 'string' ? payload._task : ''
  const definition = taskName ? opts.registry.getJobDefinition?.(taskName) : undefined
  const dedup = opts.dedupCacheSize === undefined || opts.dedupCacheSize > 0
    ? createObjectMessageDedup(opts, opts.dedupCacheSize)
    : undefined
  const markTerminal = () => {
    dedup?.mark(input.message.id)
  }

  if (!definition || definition.queue !== input.logicalQueue) {
    await opts.onInvalidPayload?.({ ...input, taskName, definition, error: taskName ? `No handler for task: ${taskName}` : 'No _task in payload' })
    markTerminal()
    input.message.ack()
    return
  }

  // Dedup duplicate at-least-once deliveries by message.id within this isolate.
  if (dedup?.has(input.message.id)) {
    await opts.onDuplicate?.({ ...input, taskName, definition })
    input.message.ack()
    return
  }

  const job: DispatchableJob = {
    id: opts.getJobId?.({ ...input, taskName, definition, payload })
      ?? `${taskName}:${stablePayloadId(payload)}`,
    queue: input.logicalQueue,
    payload,
    attempts: input.message.attempts,
    batchId: null,
    siteId: opts.getSiteId?.(payload) ?? (typeof payload.siteId === 'string' ? payload.siteId : null),
    userId: opts.getUserId?.(payload) ?? (typeof payload.userId === 'number' ? payload.userId : null),
  }

  try {
    const result = await dispatchRegisteredJob({
      registry: opts.registry,
      job,
      traceMarker: opts.traceMarker,
      createContext: ({ control, payload }) => opts.createContext({
        ...input,
        taskName,
        definition: definition as JobDefinition<string, unknown, string, Env, unknown, unknown>,
        job,
        control,
        payload,
      }),
    })

    if (!result.success) {
      await opts.onInvalidPayload?.({
        ...input,
        taskName,
        definition,
        job,
        error: result.error ? formatJobError(result.error) : undefined,
        validationError: result.error?._tag === 'invalid-payload' ? result.error.cause : undefined,
      })
      markTerminal()
      input.message.ack()
      return
    }

    if (result.control?.action === 'released') {
      input.message.retry({ delaySeconds: result.control.delaySeconds ?? 0 })
      return
    }

    if (result.control?.action === 'failed') {
      const error = new Error(result.control.error ?? 'Job failed via ctx.fail()')
      await reportRegisteredQueueError(opts, { ...input, taskName, definition, job, error })
      await runRegisteredJobFailed({ ...input, taskName, definition, job, payload }, opts, error)
        .catch(failedError => reportRegisteredQueueError(opts, { ...input, taskName, definition, job, error: failedError }))
      markTerminal()
      input.message.ack()
      return
    }

    markTerminal()
    input.message.ack()
  }
  catch (error) {
    await reportRegisteredQueueError(opts, { ...input, taskName, definition, job, error })

    const queues = typeof opts.queues === 'function' ? opts.queues(runtimeConfigSource(input.env as Record<string, unknown>)) : opts.queues
    const maxAttempts = resolveJobMaxAttempts(definition)
      ?? (typeof queues[input.logicalQueue] === 'object' ? (queues[input.logicalQueue] as { maxRetries?: number }).maxRetries : undefined)
    const exhausted = shouldSendToDlq({ attempts: input.message.attempts, maxAttempts })

    if (exhausted) {
      const dlqBindingName = typeof opts.dlqBinding === 'function'
        ? opts.dlqBinding({ logicalQueue: input.logicalQueue, definition })
        : opts.dlqBinding ?? resolveDlqBinding(queues, input.logicalQueue)
      if (dlqBindingName) {
        let sent: boolean
        try {
          sent = await sendQueueMessage(input.env as Record<string, unknown>, dlqBindingName, input.message.body)
        }
        catch (dlqError) {
          await reportRegisteredQueueError(opts, { ...input, taskName, definition, job, error: dlqError })
          throw dlqError
        }
        if (sent) {
          await opts.onDlq?.({ ...input, taskName, definition, job })
          await runRegisteredJobFailed({ ...input, taskName, definition, job, payload }, opts, error)
            .catch(failedError => reportRegisteredQueueError(opts, { ...input, taskName, definition, job, error: failedError }))
          markTerminal()
          input.message.ack()
          return
        }
      }
      // No DLQ producer configured — let CF's own DLQ config handle it (ack to drop, or fall through).
    }

    const raw = opts.retryDelaySeconds?.({ ...input, taskName, definition, job, error })
      ?? resolveJobRetryDelay(definition, input.message.attempts)
    input.message.retry({ delaySeconds: clampDelay(raw) })
  }
}

async function reportRegisteredQueueError<Env extends Record<string, unknown>, Db, Logger>(
  opts: RegisterRegisteredQueueConsumerOptions<Env, Db, Logger>,
  input: RegisteredQueueConsumerHookInput<Env> & { error: unknown },
): Promise<void> {
  if (!opts.onDispatchError) {
    console.error('[nuxt-cf-jobs] queue observer unavailable', input)
    return
  }

  await Promise.resolve()
    .then(() => opts.onDispatchError!(input))
    .catch((observerError) => {
      console.error('[nuxt-cf-jobs] queue observer failed', { ...input, observerError })
    })
}

async function runRegisteredJobFailed<Env extends Record<string, unknown>, Db, Logger>(
  input: RegisteredQueueConsumerHookInput<Env> & {
    logicalQueue: string
    taskName: string
    definition: AnyJobDefinition
    job: DispatchableJob
    payload: Record<string, unknown>
  },
  opts: RegisterRegisteredQueueConsumerOptions<Env, Db, Logger>,
  error: unknown,
): Promise<void> {
  const definition = opts.registry.loadJobDefinition
    ? await opts.registry.loadJobDefinition(input.taskName)
    : input.definition
  if (!definition?.failed)
    return
  const { _task, _continuations, ...cleanPayload } = input.payload
  const parsed = parseJobInput(definition as never, cleanPayload)
  if (!parsed.success)
    throw new Error(`Failed hook payload no longer matches task: ${input.taskName}`, { cause: parsed.error })
  const control: JobControlResult = { handled: false }
  const ctx = await opts.createContext({
    ...input,
    definition: definition as JobDefinition<string, unknown, string, Env, unknown, unknown>,
    control,
    payload: cleanPayload,
  })
  await definition.failed(parsed.data, ctx, error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isDlqQueue<Env extends Record<string, unknown>>(queueName: string, dlqQueues: DlqQueuesOption<Env> | undefined): boolean {
  if (!dlqQueues)
    return queueName.endsWith('-dlq')
  if (typeof dlqQueues === 'function')
    return dlqQueues(queueName)
  if (Array.isArray(dlqQueues))
    return dlqQueues.includes(queueName)
  return Object.hasOwn(dlqQueues as Record<string, unknown>, queueName)
}

function resolveDlqHandler<Env extends Record<string, unknown>>(
  queueName: string,
  dlqQueues: DlqQueuesOption<Env> | undefined,
): DlqQueueHandler<Env> | undefined {
  if (!dlqQueues || Array.isArray(dlqQueues) || typeof dlqQueues === 'function')
    return undefined
  return (dlqQueues as Record<string, DlqQueueHandler<Env>>)[queueName]
}

function stablePayloadId(payload: Record<string, unknown>): string {
  const value = payload.jobId
  if (typeof value === 'string' || typeof value === 'number')
    return String(value)
  return stableStringify(payload)
}

export function exponentialBackoff(
  attempts: number,
  opts: { baseSeconds?: number, maxSeconds?: number } = {},
): number {
  const base = opts.baseSeconds ?? 30
  const max = Math.min(opts.maxSeconds ?? 300, CF_QUEUE_MAX_DELAY_SECONDS)
  return Math.min(base * 2 ** Math.max(0, attempts), max)
}
