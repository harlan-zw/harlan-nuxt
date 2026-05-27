import type {
  AnyJobDefinition,
  JobNameOf,
  JobPayloadByName,
  JobQueueByName,
} from './registry'
import type {
  PrepareRegisteredDurableJobOptions,
} from './outbox'
import type {
  QueueSource,
  RegisteredQueueConsumerPayload,
  RegisterRegisteredQueueConsumerOptions,
} from './queue'
import type { QueueBindingsConfig } from './types'
import { defineJobRegistry } from './registry'
import { prepareRegisteredDurableJob } from './outbox'
import {
  assertJobQueueBindings,
  createJobQueue,
  registerRegisteredQueueConsumer,
  resolveNitroTaskEnv,
  validateJobQueueBindings,
  validateQueueBindingShape,
  validateQueueConsumerConfig,
} from './queue'
import { validateJobDefinitions } from './registry'

export interface CfJobsRuntimeConfig {
  cfJobs: { queues: QueueBindingsConfig }
}

export type CfJobsQueueConsumerOptions<Env extends Record<string, unknown>, Db, Logger>
  = Omit<RegisterRegisteredQueueConsumerOptions<Env, Db, Logger>, 'registry' | 'queues'>

export interface CreateCfJobsAppOptions {
  /** Fallback queue applied to jobs whose `defineJob` omits `queue`. */
  defaultQueue?: string
}

export function createCfJobsApp<const Jobs extends readonly AnyJobDefinition[]>(
  jobs: Jobs,
  useRuntimeConfig: (event?: unknown) => CfJobsRuntimeConfig,
  appOpts: CreateCfJobsAppOptions = {},
) {
  const effectiveJobs = (appOpts.defaultQueue
    ? jobs.map(job => (job.queue ? job : { ...job, queue: appOpts.defaultQueue }))
    : jobs) as unknown as Jobs

  const jobRegistry = defineJobRegistry(effectiveJobs)

  function getQueue<const Job extends Jobs[number]>(job: Job): ReturnType<typeof createJobQueue<Job>>
  function getQueue<const Job extends Jobs[number]>(
    source: QueueSource | undefined,
    job: Job,
  ): ReturnType<typeof createJobQueue<Job>>
  function getQueue(sourceOrJob: unknown, maybeJob?: unknown) {
    const isJobOnly = maybeJob === undefined && isJobDefinition(sourceOrJob)
    const job = (isJobOnly ? sourceOrJob : maybeJob) as AnyJobDefinition
    const source = (isJobOnly ? undefined : sourceOrJob) as QueueSource | undefined
    const resolvedSource: QueueSource | undefined = source
      ?? (() => {
        const env = resolveNitroTaskEnv()
        return env ? { context: { cloudflare: { env } } } : undefined
      })()
    const runtimeConfig = resolvedSource && typeof resolvedSource === 'object' && 'context' in resolvedSource
      ? useRuntimeConfig(resolvedSource as never)
      : useRuntimeConfig()
    return createJobQueue(resolvedSource, runtimeConfig.cfJobs.queues, job)
  }

  function buildJobPayload<Name extends JobNameOf<Jobs>>(
    name: Name,
    payload: JobPayloadByName<Jobs, Name>,
  ) {
    return jobRegistry.buildPayload(name, payload)
  }

  function prepareJob<Name extends JobNameOf<Jobs>>(
    opts: PrepareRegisteredDurableJobOptions<Jobs, Name>,
  ) {
    return prepareRegisteredDurableJob(jobRegistry, opts)
  }

  let startupLogged = false
  function logStartupWarnings(queues: QueueBindingsConfig): void {
    if (startupLogged)
      return
    startupLogged = true
    const issues: string[] = []
    for (const issue of validateJobDefinitions(effectiveJobs))
      issues.push(`[job:${issue.name}] ${issue.reason}`)
    for (const issue of validateQueueBindingShape(queues))
      issues.push(`[queue:${issue.queue}] ${issue.reason}: ${issue.detail}`)
    for (const issue of validateJobQueueBindings(queues, effectiveJobs))
      issues.push(`[job:${issue.jobName}] missing binding for queue "${issue.queue}"`)
    for (const issue of validateQueueConsumerConfig(queues, effectiveJobs))
      issues.push(`[job:${issue.jobName ?? '?'}@${issue.queue}] ${issue.reason}: ${issue.detail}`)
    if (issues.length === 0)
      return
    // eslint-disable-next-line no-console
    console.warn(`[nuxt-cf-jobs] configuration warnings:\n${issues.map(i => `  - ${i}`).join('\n')}`)
  }

  function registerQueueConsumer<Env extends Record<string, unknown>, Db, Logger>(
    nitroApp: { hooks: { hook: (name: any, handler: any) => void } },
    opts: CfJobsQueueConsumerOptions<Env, Db, Logger>,
  ) {
    const queues = useRuntimeConfig().cfJobs.queues
    logStartupWarnings(queues)
    return registerRegisteredQueueConsumer(nitroApp, {
      ...opts,
      registry: jobRegistry,
      queues: () => useRuntimeConfig().cfJobs.queues,
    })
  }

  const validateQueueBindings = (queues: QueueBindingsConfig = useRuntimeConfig().cfJobs.queues) =>
    validateJobQueueBindings(queues, effectiveJobs)

  const assertQueueBindings = (queues: QueueBindingsConfig = useRuntimeConfig().cfJobs.queues) =>
    assertJobQueueBindings(queues, effectiveJobs)

  return {
    jobs: effectiveJobs,
    jobRegistry,
    getHandler: jobRegistry.getHandler,
    getJobDefinition: jobRegistry.getJobDefinition,
    getJobQueue: jobRegistry.getJobQueue,
    getJobRoute: jobRegistry.getJobRoute,
    validateRegistry: jobRegistry.validate,
    validateQueueBindings,
    assertQueueBindings,
    getQueue,
    buildJobPayload,
    prepareJob,
    registerQueueConsumer,
  }
}

export type CfJobsApp<Jobs extends readonly AnyJobDefinition[]>
  = ReturnType<typeof createCfJobsApp<Jobs>>

export type QueueConsumerOptions<Env extends Record<string, unknown>, Db, Logger>
  = CfJobsQueueConsumerOptions<Env, Db, Logger>

function isJobDefinition(value: unknown): value is AnyJobDefinition {
  return !!value
    && typeof value === 'object'
    && typeof (value as AnyJobDefinition).name === 'string'
    && typeof (value as AnyJobDefinition).handle === 'function'
}
