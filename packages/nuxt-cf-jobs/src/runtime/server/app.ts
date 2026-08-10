import type {
  PrepareRegisteredDurableJobOptions,
} from './outbox'
import type {
  QueueBindingUnavailableInput,
  RegisteredQueueConsumerPayload,
  RegisterRegisteredQueueConsumerOptions,
} from './queue'
import type {
  AnyJobDefinition,
  JobDefinitionByName,
  JobNameOf,
  JobPayloadByName,
  LazyJobEntry,
  QueueNameOf,
} from './registry'
import type {
  CreateDurableJobsRuntimeOptions,
  DurableJobsRuntime,
  DurableJobsRuntimeRegistry,
} from './runtime'
import type { QueueSource } from './runtime-env'
import type { QueueBindingsConfig } from './types'
import { cfJobsAppExportNames } from '../shared/app-exports'
import { prepareRegisteredDurableJob } from './outbox'
import {
  assertJobQueueBindings,
  createJobQueue,
  processRegisteredQueueBatch,
  resolveQueueBindingName,
  validateJobQueueBindings,
  validateQueueBindingShape,
  validateQueueConsumerConfig,
} from './queue'
import { defineJobRegistry, validateJobDefinitions } from './registry'
import { createDurableJobsRuntime } from './runtime'
import { useJobRuntimeConfig } from './runtime-config'
import { resolveNitroTaskEnv, runtimeConfigSource } from './runtime-env'

export interface CfJobsRuntimeConfig {
  cfJobs: { queues: QueueBindingsConfig }
}

export type CfJobsQueueConsumerOptions<Env extends Record<string, unknown>, Db, Logger>
  = Omit<RegisterRegisteredQueueConsumerOptions<Env, Db, Logger>, 'registry' | 'queues'>

export type CfJobsDurableRuntimeOptions<
  Queue extends string,
  Env,
  Db,
  Logger,
> = Omit<CreateDurableJobsRuntimeOptions<Queue, Env, Db, Logger>, 'registry' | 'resolveQueueBinding'> & {
  resolveQueueBinding?: CreateDurableJobsRuntimeOptions<Queue, Env, Db, Logger>['resolveQueueBinding']
}

export type UseRuntimeConfigFn = (event?: unknown) => CfJobsRuntimeConfig

export interface CreateCfJobsAppOptions {
  /**
   * Bundled Nitro `useRuntimeConfig`. The generated `#cf-jobs/app` registry
   * passes Nuxt's auto import here. Direct consumers and tests may pass a stub.
   */
  useRuntimeConfig?: UseRuntimeConfigFn
  /** Fallback queue applied to jobs whose `defineJob` omits `queue`. */
  defaultQueue?: string
}

/**
 * Builds the registry + helpers around a statically-known array of jobs. The
 * The generated `#cf-jobs/app` template passes lazy job metadata. Each handler
 * source enters the bundle only when its `load()` thunk runs.
 *
 * `useRuntimeConfig` is injected so this module never imports `nitropack/runtime`
 * itself; that keeps `app.ts` usable from unit tests / non-nitro consumers and
 * avoids `#nitro-internal-virtual/*` pulling into anything that isn't bundled.
 */
export function createCfJobsApp<const Jobs extends readonly AnyJobDefinition[]>(
  jobs: Jobs,
  { useRuntimeConfig: injectedRuntimeConfig, defaultQueue }: CreateCfJobsAppOptions = {},
) {
  const useRuntimeConfig: UseRuntimeConfigFn = injectedRuntimeConfig
    ?? (event => useJobRuntimeConfig(event) as unknown as CfJobsRuntimeConfig)

  const materialized = (defaultQueue
    ? jobs.map(j => (j.queue ? j : { ...j, queue: defaultQueue }))
    : jobs.slice()) as unknown as Jobs

  // Eager: invalid `defineJob` shapes surface at boot rather than on first message.
  const jobIssues = validateJobDefinitions(materialized)
  if (jobIssues.length > 0) {
    console.warn(`[nuxt-cf-jobs] job definition warnings:\n${jobIssues.map(i => `  - [job:${i.name}] ${i.reason}`).join('\n')}`)
  }

  const jobRegistry = defineJobRegistry(materialized)
  const warnedUnavailableQueueSends = new Set<string>()

  // Read runtime config safely from a (possibly synthetic) queue source.
  // nitro's `useRuntimeConfig(event)` derefs `event.context.nitro.runtimeConfig`
  // unconditionally, so the synthetic `{ context: { cloudflare: { env } } }`
  // source built for scheduled tasks / queue consumers (no `context.nitro`) makes
  // it throw `Cannot read properties of undefined (reading 'runtimeConfig')`. The
  // `.cfJobs.queues` map every caller wants is build-time static and identical in
  // the shared eventless config, so read it eventlessly unless `source` is a real
  // h3 event. The env (bindings) is always resolved separately from the source.
  function readRuntimeConfig(source?: unknown): CfJobsRuntimeConfig {
    const isH3Event = !!source && typeof source === 'object' && 'context' in source
      && !!(source as { context?: { nitro?: unknown } }).context?.nitro
    return isH3Event ? useRuntimeConfig(source as never) : useRuntimeConfig()
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
    const runtimeConfig = readRuntimeConfig(resolvedSource)
    return createJobQueue(resolvedSource, runtimeConfig.cfJobs.queues, job, {
      onUnavailable: warnUnavailableQueueSend,
    })
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

  function loadJobDefinition<Name extends JobNameOf<Jobs>>(name: Name): Promise<JobDefinitionByName<Jobs, Name> | undefined>
  function loadJobDefinition(name: string): Promise<AnyJobDefinition | undefined>
  function loadJobDefinition(name: string) {
    return jobRegistry.loadJobDefinition(name)
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

  function warnUnavailableQueueSend(input: QueueBindingUnavailableInput): void {
    const key = `${input.reason}:${input.job.name}:${input.queue}:${input.binding ?? ''}`
    if (warnedUnavailableQueueSends.has(key))
      return
    warnedUnavailableQueueSends.add(key)

    const count = input.count === 1 ? '1 message' : `${input.count} messages`
    const binding = input.binding ? ` binding "${input.binding}"` : ''
    console.warn(`[nuxt-cf-jobs] job "${input.job.name}" could not enqueue ${count} on queue "${input.queue}"${binding}: ${formatQueueUnavailableReason(input)}`)
  }

  function registerQueueConsumer<Env extends Record<string, unknown>, Db, Logger>(
    nitroApp: { hooks: { hook: (name: any, handler: any) => void } },
    opts: CfJobsQueueConsumerOptions<Env, Db, Logger>,
  ) {
    const ready: RegisterRegisteredQueueConsumerOptions<Env, Db, Logger> = {
      ...opts,
      registry: jobRegistry,
      queues: (source?: QueueSource) => readRuntimeConfig(source).cfJobs.queues,
    }
    let warned = false
    nitroApp.hooks.hook('cloudflare:queue', async (payload: RegisteredQueueConsumerPayload<Env>) => {
      if (!warned) {
        warned = true
        logQueueWarnings(readRuntimeConfig(runtimeConfigSource(payload.env)).cfJobs.queues)
      }
      await processRegisteredQueueBatch(payload, ready)
    })
  }

  function createDurableRuntime<
    Queue extends QueueNameOf<Jobs> & string = QueueNameOf<Jobs> & string,
    Env = unknown,
    Db = unknown,
    Logger = unknown,
  >(opts: CfJobsDurableRuntimeOptions<Queue, Env, Db, Logger>): DurableJobsRuntime<Queue> {
    const resolveQueueBinding = opts.resolveQueueBinding ?? ((queue: Queue) => {
      const runtimeConfig = readRuntimeConfig(runtimeConfigSource(opts.env))
      return resolveQueueBindingName(runtimeConfig.cfJobs.queues, queue)
    })
    const registry: DurableJobsRuntimeRegistry<Env, Db, Logger> = {
      getHandler: name => jobRegistry.getHandler(name) as ReturnType<DurableJobsRuntimeRegistry<Env, Db, Logger>['getHandler']>,
      loadJobDefinition: name => jobRegistry.loadJobDefinition(name) as ReturnType<NonNullable<DurableJobsRuntimeRegistry<Env, Db, Logger>['loadJobDefinition']>>,
      getJobDefinition: name => jobRegistry.getJobDefinition(name) as ReturnType<NonNullable<DurableJobsRuntimeRegistry<Env, Db, Logger>['getJobDefinition']>>,
      getJobRoute: name => jobRegistry.getJobRoute(name),
    }

    return createDurableJobsRuntime({
      ...opts,
      registry,
      resolveQueueBinding,
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
    loadJobDefinition,
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
    createDurableRuntime,
  }
}

/**
 * Thin wrapper used by the generated `#cf-jobs/app` template. The template emits
 * static job data plus Nuxt's deferred runtime config auto import.
 */
export function createGeneratedCfJobsApp<const Jobs extends readonly LazyJobEntry[]>(
  jobs: Jobs,
  options: { defaultQueue?: string, useRuntimeConfig: UseRuntimeConfigFn },
) {
  // Lazy entries carry static routing metadata + a `load()` thunk instead of an
  // eager `handle`; the registry resolves handlers on demand. The precise
  // per-job payload/queue types reach consumers via the generated `#cf-jobs/app`
  // `.d.ts` augmentation, so the runtime cast here is intentional.
  return createCfJobsApp(jobs as unknown as readonly AnyJobDefinition[], options)
}

export type CfJobsApp<Jobs extends readonly AnyJobDefinition[]>
  = ReturnType<typeof createCfJobsApp<Jobs>>

/**
 * Authoritative list of `createCfJobsApp` members re-exported by the generated
 * `#cf-jobs/app` module. `generateRegistryTemplate` maps over this so the runtime
 * destructure and the app's return shape can't drift apart.
 *
 * `jobs` is exported separately by the template (as a `const` tuple), so it is
 * intentionally absent here.
 */
export { cfJobsAppExportNames }

export type QueueConsumerOptions<Env extends Record<string, unknown>, Db, Logger>
  = CfJobsQueueConsumerOptions<Env, Db, Logger>

function isJobDefinition(value: unknown): value is AnyJobDefinition {
  if (!value || typeof value !== 'object' || typeof (value as AnyJobDefinition).name !== 'string')
    return false
  // Eager defs expose `handle`; lazy entries expose `load`.
  return typeof (value as AnyJobDefinition).handle === 'function'
    || typeof (value as LazyJobEntry).load === 'function'
}

function formatQueueUnavailableReason(input: QueueBindingUnavailableInput): string {
  switch (input.reason) {
    case 'missing-config':
      return `no cfJobs.queues entry resolves queue "${input.queue}".`
    case 'missing-env':
      return 'no Cloudflare env was available; pass an H3 event/env source or run with the dev queue plugin.'
    case 'missing-env-binding':
      return `env is missing${input.binding ? ` "${input.binding}"` : ' the configured queue binding'}.`
    case 'invalid-binding':
      return `env binding "${input.binding}" is not a Cloudflare Queue binding (missing send()).`
  }
}
