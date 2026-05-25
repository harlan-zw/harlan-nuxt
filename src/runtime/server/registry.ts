import type { JobBackoff, JobDefinition, JobFailedHandler, JobHandler, JobMiddleware, JobPayloadSchema } from './types'
import { buildJobPayload } from './payload'

export type JobPayloadMap = Record<string, unknown>
export type AnyJobDefinition = JobDefinition<string, any, string, any, any, any>
export type JobDefinitionLoader<Job extends AnyJobDefinition = AnyJobDefinition> = () => Promise<Job>
export type JobDefinitionLoaderMap = Record<string, JobDefinitionLoader>
export type JobDefinitionOfLoader<Loader extends JobDefinitionLoader> = Awaited<ReturnType<Loader>>
export type JobDefinitionsByNameOfLoaders<Loaders extends JobDefinitionLoaderMap> = {
  readonly [Name in keyof Loaders]: Loaders[Name] extends JobDefinitionLoader<infer Job> ? Job : never
}
export type JobPayloadOf<Job extends AnyJobDefinition> =
  Job extends JobDefinition<string, infer Payload, string, any, any, any>
    ? Payload extends object ? Payload : never
    : never
export type JobMessageOf<Job extends AnyJobDefinition> =
  Job extends JobDefinition<infer Name, any, string, any, any, any>
    ? { _task: Name } & JobPayloadOf<Job>
    : never
export type JobNameOf<Jobs extends readonly AnyJobDefinition[]> = Jobs[number]['name']
export type JobDefinitionByName<
  Jobs extends readonly AnyJobDefinition[],
  Name extends JobNameOf<Jobs>,
> = Extract<Jobs[number], { name: Name }>
export type JobPayloadByName<
  Jobs extends readonly AnyJobDefinition[],
  Name extends JobNameOf<Jobs>,
> = JobDefinitionByName<Jobs, Name> extends JobDefinition<Name, infer Payload, string, any, any, any>
  ? Payload extends object ? Payload : never
  : never
export type JobQueueByName<
  Jobs extends readonly AnyJobDefinition[],
  Name extends JobNameOf<Jobs>,
> = JobDefinitionByName<Jobs, Name> extends JobDefinition<Name, any, infer Queue, any, any, any>
  ? Queue
  : never
export type JobMessageByName<
  Jobs extends readonly AnyJobDefinition[],
  Name extends JobNameOf<Jobs>,
> = { _task: Name } & JobPayloadByName<Jobs, Name>
export type QueueNameOf<Jobs extends readonly AnyJobDefinition[]> = Jobs[number]['queue']
export type JobMessageByQueue<
  Jobs extends readonly AnyJobDefinition[],
  Queue extends QueueNameOf<Jobs>,
> = {
  [Name in JobNameOf<Jobs>]: JobQueueByName<Jobs, Name> extends Queue
    ? JobMessageByName<Jobs, Name>
    : never
}[JobNameOf<Jobs>]

export function defineJob<
  const Name extends string,
  Payload extends object,
  const Queue extends string,
  Env = unknown,
  Db = unknown,
  Logger = unknown,
>(opts: {
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
}): JobDefinition<Name, Payload, Queue, Env, Db, Logger> {
  return opts
}

export function parseJobInput<Payload>(
  definition: Pick<JobDefinition<string, Payload, string, unknown, unknown, unknown>, 'input'> | undefined,
  payload: unknown,
): { success: true, data: Payload } | { success: false, error: unknown } {
  if (!definition?.input)
    return { success: true, data: payload as Payload }

  return definition.input.safeParse(payload)
}

export function buildJobMessage<const Job extends AnyJobDefinition>(
  definition: Job,
  payload: JobPayloadOf<Job>,
): JobMessageOf<Job> {
  const parsed = parseJobInput(definition, payload)
  if (!parsed.success)
    throw new Error(`Invalid payload for task: ${definition.name}`)
  return buildJobPayload(definition.name, parsed.data as JobPayloadOf<Job>) as JobMessageOf<Job>
}

export function defineJobRegistry<
  const Jobs extends readonly AnyJobDefinition[],
>(jobs: Jobs) {
  const handlers = new Map<string, JobHandler<unknown, unknown, unknown, unknown>>(
    jobs.map(job => [job.name, job.handle as JobHandler<unknown, unknown, unknown, unknown>]),
  )

  function getJobDefinition<Name extends JobNameOf<Jobs>>(name: Name): JobDefinitionByName<Jobs, Name> | undefined
  function getJobDefinition(name: string): AnyJobDefinition | undefined
  function getJobDefinition(name: string) {
    return jobs.find(job => job.name === name)
  }

  function getJobQueue<Name extends JobNameOf<Jobs>>(name: Name): JobQueueByName<Jobs, Name> | undefined
  function getJobQueue(name: string): string | undefined
  function getJobQueue(name: string) {
    return jobs.find(job => job.name === name)?.queue
  }

  return {
    jobs,
    handlers,
    getHandler(name: string) {
      return handlers.get(name)
    },
    getJobDefinition,
    getJobQueue,
    buildPayload<Name extends JobNameOf<Jobs>>(
      name: Name,
      payload: JobPayloadByName<Jobs, Name>,
    ): { _task: Name } & JobPayloadByName<Jobs, Name> {
      const definition = jobs.find(job => job.name === name)
      if (!definition)
        throw new Error(`Unknown task: ${name}`)
      return buildJobMessage(definition as JobDefinitionByName<Jobs, Name>, payload) as { _task: Name } & JobPayloadByName<Jobs, Name>
    },
    getJobRoute(name: string) {
      const job = jobs.find(job => job.name === name)
      return job ? { queue: job.queue, jobType: job.jobType ?? job.name } : undefined
    },
    validate(expectedTasks: readonly string[]) {
      const registered = new Set(handlers.keys())
      const expected = new Set(expectedTasks)
      return {
        missing: expectedTasks.filter(task => !registered.has(task)),
        extra: [...registered].filter(task => !expected.has(task)),
      }
    },
  }
}
