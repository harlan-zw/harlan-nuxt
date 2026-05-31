import type { JobRegistryLike } from './dispatch'
import type { DurableJobFailureRepository } from './outbox'
import type { AnyJobDefinition, JobMessageOf, JobPayloadOf } from './registry'
import type { CloudflareQueue, CloudflareQueueSendBatchMessage, DispatchableJob, JobContext, JobControlResult, JobDefinition, QueueBindingsConfig, QueuePayload, QueueSendOptions } from './types'
import { dispatchRegisteredJob } from './dispatch'
import { CF_QUEUE_MAX_DELAY_SECONDS, stableStringify } from './internal'
import { clampDelay, resolveJobMaxAttempts, resolveJobRetryDelay } from './policy'
import { buildJobMessage } from './registry'

export { CF_QUEUE_MAX_DELAY_SECONDS } from './internal'

export const CF_QUEUE_MAX_BATCH_SIZE = 100
export const CF_QUEUE_MAX_BATCH_BYTES = 256 * 1024
export const CF_QUEUE_MAX_MESSAGE_BYTES = 128 * 1024
const TRANSIENT_QUEUE_ERROR_RE = /\b(?:429|rate limit|too many requests|backpressure)\b/i

function chunkBatch<T>(items: readonly T[], size: number): T[][] {
  if (items.length <= size)
    return [items as T[]]
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size))
  return out
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
  for (const slice of chunkBatch(messages, CF_QUEUE_MAX_BATCH_SIZE)) {
    if (typeof cfQueue.sendBatch === 'function') {
      await withSendBackpressure(
        () => cfQueue.sendBatch!(slice.map(body => ({ body })), sendOpts),
        opts,
      )
    }
    else {
      await Promise.all(slice.map(message => withSendBackpressure(() => cfQueue.send(message, sendOpts), opts)))
    }
  }
}

export async function sendBatchMessagesChunked<T>(
  cfQueue: CloudflareQueue<T>,
  messages: Array<CloudflareQueueSendBatchMessage<T>>,
  opts?: SendBackpressureOptions,
): Promise<void> {
  for (const slice of chunkBatch(messages, CF_QUEUE_MAX_BATCH_SIZE)) {
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

export type QueueSource
  = | Record<string, unknown>
    | {
      context?: {
        cloudflare?: {
          env?: Record<string, unknown>
        } | unknown
      } | unknown
    }

export interface JobQueuePublisher<Job extends AnyJobDefinition> {
  send: (payload: JobPayloadOf<Job>, opts?: QueueSendOptions & SendBackpressureOptions) => Promise<boolean>
  sendBatch: (payloads: Array<JobPayloadOf<Job>>, opts?: QueueSendOptions & SendBackpressureOptions) => Promise<boolean>
  sendBatchMessages: (
    messages: Array<{ payload: JobPayloadOf<Job>, delaySeconds?: number, contentType?: import('./types').QueueMessageContentType }>,
    opts?: SendBackpressureOptions,
  ) => Promise<boolean>
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

/**
 * Resolves the Cloudflare runtime env from a Nitro task context where no `H3Event` is available.
 *
 * Nitro tasks (`defineTask`) run without an event, so Cloudflare bindings must be threaded through
 * `globalThis.__env__`. This helper reads that shim and returns the env (or `undefined`).
 */
export function resolveNitroTaskEnv(): Record<string, unknown> | undefined {
  const globalEnv = (globalThis as { __env__?: unknown }).__env__
  if (globalEnv && typeof globalEnv === 'object')
    return globalEnv as Record<string, unknown>
  return undefined
}

export function resolveQueueSourceEnv(source: QueueSource | undefined): Record<string, unknown> | undefined {
  if (!source)
    return undefined

  const maybeEvent = source as { context?: { cloudflare?: { env?: Record<string, unknown> } } }
  return maybeEvent.context?.cloudflare?.env ?? source as Record<string, unknown>
}

/**
 * Wraps a Cloudflare env as the event-shaped source `useRuntimeConfig` expects.
 * Queue consumers run without an `H3Event`, so without this the `queues` resolver
 * would call `useRuntimeConfig()` bare and miss per-deployment `NUXT_*` env overrides.
 */
export function runtimeConfigSource(env: Record<string, unknown>): QueueSource {
  return { context: { cloudflare: { env } } }
}

export function createJobQueue<const Job extends AnyJobDefinition>(
  source: QueueSource | undefined,
  queues: QueueBindingsConfig,
  definition: Job,
): JobQueuePublisher<Job> {
  const env = resolveQueueSourceEnv(source)

  function getQueue(): CloudflareQueue<JobMessageOf<Job>> | undefined {
    const binding = resolveQueueBindingName(queues, definition.queue)
    if (!binding)
      return undefined
    const queue = env?.[binding] as CloudflareQueue<JobMessageOf<Job>> | undefined
    return queue && typeof queue.send === 'function' ? queue : undefined
  }

  return {
    async send(payload, opts) {
      const queue = getQueue()
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

      const queue = getQueue()
      if (!queue)
        return false

      const messages = payloads.map(payload => buildJobMessage(definition, payload))
      await sendBatchChunked(queue, messages, opts)
      return true
    },
    async sendBatchMessages(messages, opts) {
      if (messages.length === 0)
        return true

      const queue = getQueue()
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
        if (handler?.persist && opts.dlqRepository) {
          const definition = taskName ? opts.registry.getJobDefinition?.(taskName) : undefined
          await opts.dlqRepository.recordFailure({
            id: jobId,
            queue: definition?.queue ?? payload.batch.queue,
            jobType: definition?.jobType ?? taskName ?? payload.batch.queue,
            payload: typeof message.body === 'string' ? message.body : JSON.stringify(message.body),
            exception: `[DLQ ${payload.batch.queue}]`,
            attempts: message.attempts,
          }).catch(error => opts.onDispatchError?.({ env: payload.env, batch: payload.batch, message, error }))
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

const DEFAULT_DEDUP_CACHE_SIZE = 1024
const dedupCaches = new WeakMap<object, Set<string>>()

function recordMessageId(opts: object, id: string, capacity: number): boolean {
  let cache = dedupCaches.get(opts)
  if (!cache) {
    cache = new Set()
    dedupCaches.set(opts, cache)
  }
  if (cache.has(id))
    return true
  cache.add(id)
  if (cache.size > capacity) {
    const first = cache.values().next().value
    if (first !== undefined)
      cache.delete(first)
  }
  return false
}

async function processRegisteredQueueMessage<Env extends Record<string, unknown>, Db, Logger>(
  input: RegisteredQueueConsumerHookInput<Env> & { logicalQueue: string, message: RegisteredQueueConsumerMessage },
  opts: RegisterRegisteredQueueConsumerOptions<Env, Db, Logger>,
) {
  const payload = isRecord(input.message.body) ? input.message.body : {}
  const taskName = typeof payload._task === 'string' ? payload._task : ''
  const definition = taskName ? opts.registry.getJobDefinition?.(taskName) : undefined

  if (!definition || definition.queue !== input.logicalQueue) {
    await opts.onInvalidPayload?.({ ...input, taskName, definition, error: taskName ? `No handler for task: ${taskName}` : 'No _task in payload' })
    input.message.ack()
    return
  }

  // Dedup duplicate at-least-once deliveries by message.id within this isolate.
  const dedupCapacity = opts.dedupCacheSize ?? DEFAULT_DEDUP_CACHE_SIZE
  if (dedupCapacity > 0 && input.message.id) {
    const seen = recordMessageId(opts, input.message.id, dedupCapacity)
    if (seen) {
      await opts.onDuplicate?.({ ...input, taskName, definition })
      input.message.ack()
      return
    }
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
        error: result.error,
        validationError: result.validationError,
      })
      input.message.ack()
      return
    }

    if (result.control?.action === 'released')
      return

    input.message.ack()
  }
  catch (error) {
    await opts.onDispatchError?.({ ...input, taskName, definition, job, error })

    const queues = typeof opts.queues === 'function' ? opts.queues(runtimeConfigSource(input.env as Record<string, unknown>)) : opts.queues
    const maxAttempts = resolveJobMaxAttempts(definition)
      ?? (typeof queues[input.logicalQueue] === 'object' ? (queues[input.logicalQueue] as { maxRetries?: number }).maxRetries : undefined)
    const exhausted = shouldSendToDlq({ attempts: input.message.attempts, maxAttempts })

    if (exhausted) {
      const dlqBindingName = typeof opts.dlqBinding === 'function'
        ? opts.dlqBinding({ logicalQueue: input.logicalQueue, definition })
        : opts.dlqBinding ?? resolveDlqBinding(queues, input.logicalQueue)
      if (dlqBindingName) {
        const sent = await sendQueueMessage(input.env as Record<string, unknown>, dlqBindingName, input.message.body).catch(() => false)
        if (sent) {
          await opts.onDlq?.({ ...input, taskName, definition, job })
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
