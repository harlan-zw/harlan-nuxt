import type {
  PrepareRegisteredDurableJobOptions,
} from './outbox'
import type {
  QueueSource,
  RegisteredQueueConsumerPayload,
  RegisterRegisteredQueueConsumerOptions,
} from './queue'
import type {
  AnyJobDefinition,
  JobNameOf,
  JobPayloadByName,
} from './registry'
import type { QueueBindingsConfig } from './types'
import { prepareRegisteredDurableJob } from './outbox'
import {
  assertJobQueueBindings,
  createJobQueue,
  processRegisteredQueueBatch,
  resolveNitroTaskEnv,
  runtimeConfigSource,
  validateJobQueueBindings,
  validateQueueBindingShape,
  validateQueueConsumerConfig,
} from './queue'
import { defineJobRegistry, validateJobDefinitions } from './registry'

export interface CfJobsRuntimeConfig {
  cfJobs: { queues: QueueBindingsConfig }
}

export type CfJobsQueueConsumerOptions<Env extends Record<string, unknown>, Db, Logger>
  = Omit<RegisterRegisteredQueueConsumerOptions<Env, Db, Logger>, 'registry' | 'queues'>

export type UseRuntimeConfigFn = (event?: unknown) => CfJobsRuntimeConfig

export interface CreateCfJobsAppOptions {
  /** Bundled nitro's `useRuntimeConfig`. Required — tests can pass a stub. */
  useRuntimeConfig: UseRuntimeConfigFn
  /** Fallback queue applied to jobs whose `defineJob` omits `queue`. */
  defaultQueue?: string
}

/**
 * Builds the registry + helpers around a statically-known array of jobs. The
 * generated `#cf-jobs/app` template imports each job source file directly and
 * passes the resulting array in — rollup resolves nuxt `#aliases` and
 * extensionless paths inside the bundle.
 *
 * `useRuntimeConfig` is injected so this module never imports `nitropack/runtime`
 * itself; that keeps `app.ts` usable from unit tests / non-nitro consumers and
 * avoids `#nitro-internal-virtual/*` pulling into anything that isn't bundled.
 */
export function createCfJobsApp<const Jobs extends readonly AnyJobDefinition[]>(
  jobs: Jobs,
  { useRuntimeConfig, defaultQueue }: CreateCfJobsAppOptions,
) {
  const materialized = (defaultQueue
    ? jobs.map(j => (j.queue ? j : { ...j, queue: defaultQueue }))
    : jobs.slice()) as unknown as Jobs

  const jobRegistry = defineJobRegistry(materialized)

  // Eager: invalid `defineJob` shapes surface at boot rather than on first message.
  const jobIssues = validateJobDefinitions(materialized)
  if (jobIssues.length > 0) {
    console.warn(`[nuxt-cf-jobs] job definition warnings:\n${jobIssues.map(i => `  - [job:${i.name}] ${i.reason}`).join('\n')}`)
  }

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

  // Queue-binding validation depends on runtimeConfig — runs on first batch only.
  function logQueueWarnings(queues: QueueBindingsConfig): void {
    const issues: string[] = []
    for (const issue of validateQueueBindingShape(queues))
      issues.push(`[queue:${issue.queue}] ${issue.reason}: ${issue.detail}`)
    for (const issue of validateJobQueueBindings(queues, materialized))
      issues.push(`[job:${issue.jobName}] missing binding for queue "${issue.queue}"`)
    for (const issue of validateQueueConsumerConfig(queues, materialized))
      issues.push(`[job:${issue.jobName ?? '?'}@${issue.queue}] ${issue.reason}: ${issue.detail}`)
    if (issues.length === 0)
      return

    console.warn(`[nuxt-cf-jobs] queue config warnings:\n${issues.map(i => `  - ${i}`).join('\n')}`)
  }

  function registerQueueConsumer<Env extends Record<string, unknown>, Db, Logger>(
    nitroApp: { hooks: { hook: (name: any, handler: any) => void } },
    opts: CfJobsQueueConsumerOptions<Env, Db, Logger>,
  ) {
    const ready: RegisterRegisteredQueueConsumerOptions<Env, Db, Logger> = {
      ...opts,
      registry: jobRegistry,
      queues: (source?: QueueSource) => useRuntimeConfig(source as never).cfJobs.queues,
    }
    let warned = false
    nitroApp.hooks.hook('cloudflare:queue', async (payload: RegisteredQueueConsumerPayload<Env>) => {
      if (!warned) {
        warned = true
        logQueueWarnings(useRuntimeConfig(runtimeConfigSource(payload.env) as never).cfJobs.queues)
      }
      await processRegisteredQueueBatch(payload, ready)
    })
  }

  const validateQueueBindings = (queues: QueueBindingsConfig = useRuntimeConfig().cfJobs.queues) =>
    validateJobQueueBindings(queues, materialized)

  const assertQueueBindings = (queues: QueueBindingsConfig = useRuntimeConfig().cfJobs.queues) =>
    assertJobQueueBindings(queues, materialized)

  return {
    jobs: materialized,
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

/**
 * Thin wrapper used by the generated `#cf-jobs/app` template: bridges nitro's
 * `useRuntimeConfig` (whose types aren't visible from this package, hence the
 * `any` param + cast) to the strictly-typed injectable. Keeping this here means
 * the template emits only dynamic data, and the cast is type-checked in source.
 */
export function createGeneratedCfJobsApp<const Jobs extends readonly AnyJobDefinition[]>(
  jobs: Jobs,

  useRuntimeConfig: (...args: any[]) => any,
  defaultQueue?: string,
) {
  return createCfJobsApp(jobs, { useRuntimeConfig: useRuntimeConfig as UseRuntimeConfigFn, defaultQueue })
}

export type CfJobsApp<Jobs extends readonly AnyJobDefinition[]>
  = ReturnType<typeof createCfJobsApp<Jobs>>

/**
 * Authoritative list of `createCfJobsApp` members re-exported by the generated
 * `#cf-jobs/app` module. The build-time templates (`generateRegistryTemplate` /
 * `generateRegistryTypesTemplate`) map over this so the runtime destructure, the
 * `.d.ts` declarations, and the app's return shape can't drift apart.
 *
 * `jobs` is exported separately by the template (as a `const` tuple), so it is
 * intentionally absent here.
 */
export const cfJobsAppExportNames = [
  'jobRegistry',
  'getHandler',
  'getJobDefinition',
  'getJobQueue',
  'getJobRoute',
  'validateRegistry',
  'validateQueueBindings',
  'assertQueueBindings',
  'getQueue',
  'buildJobPayload',
  'prepareJob',
  'registerQueueConsumer',
] as const satisfies readonly Exclude<keyof CfJobsApp<readonly AnyJobDefinition[]>, 'jobs'>[]

export type QueueConsumerOptions<Env extends Record<string, unknown>, Db, Logger>
  = CfJobsQueueConsumerOptions<Env, Db, Logger>

function isJobDefinition(value: unknown): value is AnyJobDefinition {
  return !!value
    && typeof value === 'object'
    && typeof (value as AnyJobDefinition).name === 'string'
    && typeof (value as AnyJobDefinition).handle === 'function'
}
