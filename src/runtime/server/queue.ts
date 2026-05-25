import type { JobRegistryLike } from './dispatch'
import type { AnyJobDefinition, JobMessageOf, JobPayloadOf } from './registry'
import type { CloudflareQueue, DispatchableJob, JobContext, JobControlResult, JobDefinition, QueueBindingsConfig, QueueHandlerResult, QueuePayload } from './types'
import { buildJobMessage } from './registry'
import { dispatchRegisteredJob } from './dispatch'

export type QueueSource =
  | Record<string, unknown>
  | {
    context?: {
      cloudflare?: {
        env?: Record<string, unknown>
      }
    }
  }

export interface JobQueuePublisher<Job extends AnyJobDefinition> {
  send: (payload: JobPayloadOf<Job>, opts?: { delaySeconds?: number }) => Promise<boolean>
  sendBatch: (payloads: Array<JobPayloadOf<Job>>, opts?: { delaySeconds?: number }) => Promise<boolean>
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

export function resolveQueueSourceEnv(source: QueueSource | undefined): Record<string, unknown> | undefined {
  if (!source)
    return undefined

  const maybeEvent = source as { context?: { cloudflare?: { env?: Record<string, unknown> } } }
  return maybeEvent.context?.cloudflare?.env ?? source as Record<string, unknown>
}

export function createJobQueue<const Job extends AnyJobDefinition>(
  source: QueueSource | undefined,
  queues: QueueBindingsConfig,
  definition: Job,
): JobQueuePublisher<Job> {
  const env = resolveQueueSourceEnv(source)

  function getQueue(): CloudflareQueue<JobMessageOf<Job>> | undefined {
    return getQueueBindingByName<JobMessageOf<Job>>(env, queues, definition.queue)
  }

  return {
    async send(payload, opts) {
      const queue = getQueue()
      if (!queue)
        return false

      await queue.send(buildJobMessage(definition, payload), opts)
      return true
    },
    async sendBatch(payloads, opts) {
      if (payloads.length === 0)
        return true

      const queue = getQueue()
      if (!queue)
        return false

      const messages = payloads.map(payload => buildJobMessage(definition, payload))
      if (typeof queue.sendBatch === 'function') {
        await queue.sendBatch(messages.map(body => ({ body })), opts)
        return true
      }

      await Promise.all(messages.map(message => queue.send(message, opts)))
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

export function getQueueBindingByName<T>(
  env: Record<string, unknown> | undefined,
  queues: QueueBindingsConfig,
  queueName: string,
): CloudflareQueue<T> | undefined {
  const binding = resolveQueueBindingName(queues, queueName)
  return binding ? getQueueBinding<T>(env, binding) : undefined
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

export async function sendQueueMessage<T>(
  env: Record<string, unknown> | undefined,
  binding: string,
  message: T,
  opts?: { delaySeconds?: number },
): Promise<boolean> {
  const queue = getQueueBinding<T>(env, binding)
  if (!queue)
    return false
  await queue.send(message, opts)
  return true
}

export async function sendQueueBatch<T>(
  env: Record<string, unknown> | undefined,
  binding: string,
  messages: T[],
  opts?: { delaySeconds?: number },
): Promise<boolean> {
  if (messages.length === 0)
    return true

  const queue = getQueueBinding<T>(env, binding)
  if (!queue)
    return false

  if (typeof queue.sendBatch === 'function') {
    await queue.sendBatch(messages.map(body => ({ body })), opts)
    return true
  }

  await Promise.all(messages.map(message => queue.send(message, opts)))
  return true
}

export async function sendNamedQueueMessage<T>(
  env: Record<string, unknown> | undefined,
  queues: QueueBindingsConfig,
  queueName: string,
  message: T,
  opts?: { delaySeconds?: number },
): Promise<boolean> {
  const binding = resolveQueueBindingName(queues, queueName)
  return sendQueueMessage(env, binding ?? '', message, opts)
}

export async function sendNamedQueueBatch<T>(
  env: Record<string, unknown> | undefined,
  queues: QueueBindingsConfig,
  queueName: string,
  messages: T[],
  opts?: { delaySeconds?: number },
): Promise<boolean> {
  const binding = resolveQueueBindingName(queues, queueName)
  return sendQueueBatch(env, binding ?? '', messages, opts)
}

export function registerQueueConsumer<T, Env extends Record<string, unknown>>(
  nitroApp: { hooks: { hook: (name: string, handler: (payload: QueuePayload<T, Env>) => Promise<void>) => void } },
  queueName: string,
  handler: (payload: QueuePayload<T, Env>) => Promise<void>,
) {
  nitroApp.hooks.hook('cloudflare:queue', async (payload) => {
    if (payload.batch.queue === queueName)
      await handler(payload)
  })
}

export interface RegisteredQueueConsumerMessage<T = Record<string, unknown>> {
  body: T
  attempts: number
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
  queues: QueueBindingsConfig | (() => QueueBindingsConfig)
  createContext: (input: RegisteredQueueConsumerContextInput<Env>) => JobContext<Env, Db, Logger> | Promise<JobContext<Env, Db, Logger>>
  getJobId?: (input: RegisteredQueueConsumerHookInput<Env> & { payload: Record<string, unknown> }) => string
  getSiteId?: (payload: Record<string, unknown>) => string | null | undefined
  getUserId?: (payload: Record<string, unknown>) => number | null | undefined
  retryDelaySeconds?: (input: RegisteredQueueConsumerHookInput<Env> & { error: unknown }) => number
  dlqQueues?: readonly string[] | ((queueName: string) => boolean)
  onMissingQueue?: (input: RegisteredQueueConsumerHookInput<Env>) => void | Promise<void>
  onInvalidPayload?: (input: RegisteredQueueConsumerHookInput<Env> & { error?: string, validationError?: unknown }) => void | Promise<void>
  onDispatchError?: (input: RegisteredQueueConsumerHookInput<Env> & { error: unknown }) => void | Promise<void>
  onDlq?: (input: RegisteredQueueConsumerHookInput<Env>) => void | Promise<void>
}

export function registerRegisteredQueueConsumer<Env extends Record<string, unknown>, Db, Logger>(
  nitroApp: { hooks: { hook: (name: string, handler: (payload: RegisteredQueueConsumerPayload<Env>) => Promise<void>) => void } },
  opts: RegisterRegisteredQueueConsumerOptions<Env, Db, Logger>,
) {
  nitroApp.hooks.hook('cloudflare:queue', async payload => processRegisteredQueueBatch(payload, opts))
}

export async function processRegisteredQueueBatch<Env extends Record<string, unknown>, Db, Logger>(
  payload: RegisteredQueueConsumerPayload<Env>,
  opts: RegisterRegisteredQueueConsumerOptions<Env, Db, Logger>,
) {
  const queues = typeof opts.queues === 'function' ? opts.queues() : opts.queues
  const logicalQueue = resolveLogicalQueueName(queues, payload.batch.queue)

  if (!logicalQueue) {
    if (isDlqQueue(payload.batch.queue, opts.dlqQueues)) {
      for (const message of payload.batch.messages) {
        await opts.onDlq?.({ env: payload.env, batch: payload.batch, message })
        message.ack()
      }
    }
    return
  }

  if (opts.registry.jobs && !opts.registry.jobs.some(job => job.queue === logicalQueue)) {
    await opts.onMissingQueue?.({ env: payload.env, batch: payload.batch, message: payload.batch.messages[0]!, logicalQueue })
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

  if (!definition || definition.queue !== input.logicalQueue) {
    await opts.onInvalidPayload?.({ ...input, taskName, definition, error: taskName ? `No handler for task: ${taskName}` : 'No _task in payload' })
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
    input.message.retry({
      delaySeconds: opts.retryDelaySeconds?.({ ...input, taskName, definition, job, error })
        ?? exponentialBackoff(input.message.attempts),
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isDlqQueue(queueName: string, dlqQueues: RegisterRegisteredQueueConsumerOptions<Record<string, unknown>, unknown, unknown>['dlqQueues']): boolean {
  if (typeof dlqQueues === 'function')
    return dlqQueues(queueName)
  if (dlqQueues)
    return dlqQueues.includes(queueName)
  return queueName.endsWith('-dlq')
}

function stablePayloadId(payload: Record<string, unknown>): string {
  for (const key of ['jobId', 'scanId', 'scheduledReportId', 'dripEmailId', 'keywordId', 'competitorId', 'siteId', 'teamId', 'userId', 'customerId', 'subscriptionId']) {
    const value = payload[key]
    if (typeof value === 'string' || typeof value === 'number')
      return String(value)
  }
  return 'unknown'
}

export function exponentialBackoff(
  attempts: number,
  opts: { baseSeconds?: number, maxSeconds?: number } = {},
): number {
  const base = opts.baseSeconds ?? 30
  const max = opts.maxSeconds ?? 300
  return Math.min(base * 2 ** Math.max(0, attempts), max)
}

export function ackTerminal<T>(message: { ack: () => void }, _result?: T): QueueHandlerResult {
  message.ack()
  return { action: 'ack' }
}

export function ackBatch(batch: { ackAll?: () => void, messages: Array<{ ack: () => void }> }): QueueHandlerResult {
  if (batch.ackAll) {
    batch.ackAll()
  }
  else {
    for (const message of batch.messages)
      message.ack()
  }
  return { action: 'ack' }
}

export function retryTransient(
  message: { retry: (opts?: { delaySeconds?: number }) => void, attempts: number },
  opts: { baseSeconds?: number, maxSeconds?: number, delaySeconds?: number } = {},
): QueueHandlerResult {
  const delaySeconds = opts.delaySeconds ?? exponentialBackoff(message.attempts, opts)
  message.retry({ delaySeconds })
  return { action: 'retry', delaySeconds }
}

export function retryBatch(
  batch: { retryAll?: (opts?: { delaySeconds?: number }) => void, messages: Array<{ retry: (opts?: { delaySeconds?: number }) => void }> },
  opts: { delaySeconds?: number } = {},
): QueueHandlerResult {
  if (batch.retryAll) {
    batch.retryAll(opts)
  }
  else {
    for (const message of batch.messages)
      message.retry(opts)
  }
  return { action: 'retry', delaySeconds: opts.delaySeconds }
}
