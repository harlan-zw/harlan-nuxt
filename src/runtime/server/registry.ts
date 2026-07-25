import type { CfJobsBroadcastEnvelope, CfJobsBroadcastMessage } from '../shared/broadcast'
import type { JobBackoff, JobBroadcastDefinition, JobDefinition, JobFailedHandler, JobHandler, JobMiddleware, JobPayloadSchema } from './types'
import { buildJobPayload } from './payload'

export type JobPayloadMap = Record<string, unknown>
export type AnyJobDefinition = JobDefinition<string, any, string, any, any, any>
export interface JobDefinitionShape {
  name: string
  queue: string
  handle: (payload: any, ...args: any[]) => any
  broadcast?: (...args: any[]) => any
}
type JobBroadcastShape = Pick<JobDefinitionShape, 'name'> & Partial<Pick<JobDefinitionShape, 'broadcast'>>
interface DefineJobBaseOptions<
  Name extends string,
  Payload extends object,
  Queue extends string,
  Env,
  Db,
  Logger,
> {
  name: Name
  /** Logical queue name. Optional only when `cfJobs.defaultQueue` is configured. */
  queue?: Queue
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

/**
 * A build-time registry entry that defers loading the handler module. The
 * static routing fields are AST-extracted from the job's `defineJob({...})`
 * call so the producer/consumer can route, validate queues and resolve attempts
 * WITHOUT importing (and evaluating) the handler. `load()` pulls the full
 * definition for dispatch and durable producer preparation. This keeps a worker
 * from evaluating every job module to run or prepare one job.
 */
export interface LazyJobEntry<Name extends string = string, Queue extends string = string> {
  name: Name
  queue?: Queue
  jobType?: string
  maxAttempts?: number
  tries?: number
  unique?: boolean
  /** Whether the source `defineJob` declares an `input` schema (AST flag). */
  hasInput?: boolean
  /** Whether the source `defineJob` declares a `uniqueId` fn (AST flag). */
  hasUniqueId?: boolean
  load: () => Promise<AnyJobDefinition>
}

/** Either an eagerly-constructed definition or a lazily-loaded entry. */
export type RegistryEntry = AnyJobDefinition | LazyJobEntry

export function isLazyJobEntry(entry: RegistryEntry): entry is LazyJobEntry {
  return typeof (entry as LazyJobEntry).load === 'function'
    && typeof (entry as AnyJobDefinition).handle !== 'function'
}

/** Static routing metadata shared by eager defs and lazy entries. */
export type JobStaticDefinition = Pick<
  AnyJobDefinition,
  'name' | 'queue' | 'jobType' | 'maxAttempts' | 'tries' | 'unique'
>

function toStaticDefinition(entry: RegistryEntry): JobStaticDefinition {
  return {
    name: entry.name,
    queue: entry.queue as string,
    jobType: entry.jobType,
    maxAttempts: entry.maxAttempts,
    tries: entry.tries,
    unique: entry.unique,
  }
}
export type JobPayloadOf<Job extends Pick<JobDefinitionShape, 'handle'>>
  = Job['handle'] extends (payload: infer Payload, ...args: any[]) => any
    ? Payload extends object ? Payload : never
    : never
export type JobMessageOf<Job extends Pick<JobDefinitionShape, 'handle' | 'name'>>
  = Job extends { name: infer Name extends string }
    ? { _task: Name } & JobPayloadOf<Job>
    : never
export type JobNameOf<Jobs extends readonly Pick<JobDefinitionShape, 'name'>[]> = Jobs[number]['name']
export type JobDefinitionByName<
  Jobs extends readonly Pick<JobDefinitionShape, 'name'>[],
  Name extends JobNameOf<Jobs>,
> = Extract<Jobs[number], { name: Name }>
export type JobPayloadByName<
  Jobs extends readonly Pick<JobDefinitionShape, 'handle' | 'name'>[],
  Name extends JobNameOf<Jobs>,
> = JobPayloadOf<JobDefinitionByName<Jobs, Name>>
export type JobQueueByName<
  Jobs extends readonly Pick<JobDefinitionShape, 'name' | 'queue'>[],
  Name extends JobNameOf<Jobs>,
> = JobDefinitionByName<Jobs, Name> extends { queue: infer Queue extends string }
  ? Queue
  : never
export type JobMessageByName<
  Jobs extends readonly Pick<JobDefinitionShape, 'handle' | 'name'>[],
  Name extends JobNameOf<Jobs>,
> = { _task: Name } & JobPayloadByName<Jobs, Name>
export type QueueNameOf<Jobs extends readonly Pick<JobDefinitionShape, 'queue'>[]> = Jobs[number]['queue']
export type JobMessageByQueue<
  Jobs extends readonly Pick<JobDefinitionShape, 'handle' | 'name' | 'queue'>[],
  Queue extends QueueNameOf<Jobs>,
> = {
  [Name in JobNameOf<Jobs>]: JobQueueByName<Jobs, Name> extends Queue
    ? JobMessageByName<Jobs, Name>
    : never
}[JobNameOf<Jobs>]
type JobBroadcastReturnOf<Job extends Partial<Pick<JobDefinitionShape, 'broadcast'>>>
  = Job extends { broadcast: (...args: any[]) => infer Result }
    ? Awaited<Result>
    : never
type JobBroadcastMessageFromResult<Result>
  = Exclude<Result, false | null | undefined> extends infer Clean
    ? Clean extends readonly (infer Item)[]
      ? Extract<Item, CfJobsBroadcastMessage>
      : Extract<Clean, CfJobsBroadcastMessage>
    : never
type JobBroadcastDataOf<Message>
  = Message extends { data?: infer Data } ? Data : unknown
export type JobBroadcastMessageOf<Job extends Partial<Pick<JobDefinitionShape, 'broadcast'>>>
  = JobBroadcastMessageFromResult<JobBroadcastReturnOf<Job>>
export type JobBroadcastEnvelopeOf<Job extends Partial<Pick<JobDefinitionShape, 'broadcast'>>>
  = JobBroadcastMessageOf<Job> extends infer Message
    ? Message extends CfJobsBroadcastMessage
      ? CfJobsBroadcastEnvelope<JobBroadcastDataOf<Message>> & { event: Message['event'] }
      : never
    : never
export type JobBroadcastMessageByName<
  Jobs extends readonly JobBroadcastShape[],
  Name extends JobNameOf<Jobs>,
> = JobBroadcastMessageOf<JobDefinitionByName<Jobs, Name>>
export type JobBroadcastEnvelopeByName<
  Jobs extends readonly JobBroadcastShape[],
  Name extends JobNameOf<Jobs>,
> = JobBroadcastEnvelopeOf<JobDefinitionByName<Jobs, Name>>
export type BroadcastMessageOf<Jobs extends readonly Partial<Pick<JobDefinitionShape, 'broadcast'>>[]> = JobBroadcastMessageOf<Jobs[number]>
export type BroadcastEnvelopeOf<Jobs extends readonly Partial<Pick<JobDefinitionShape, 'broadcast'>>[]> = JobBroadcastEnvelopeOf<Jobs[number]>

export interface JobDefinitionValidationIssue {
  name: string
  reason: 'invalid-definition' | 'duplicate-name' | 'invalid-queue'
}

export function defineJob<
  const Name extends string,
  Payload extends object,
  const Queue extends string = string,
  Env = unknown,
  Db = unknown,
  Logger = unknown,
  const Broadcast extends JobBroadcastDefinition<Payload, Env> = JobBroadcastDefinition<Payload, Env>,
>(
  opts: DefineJobBaseOptions<Name, Payload, Queue, Env, Db, Logger>
    & { broadcast: Broadcast & JobBroadcastDefinition<Payload, Env> },
): JobDefinition<Name, Payload, Queue, Env, Db, Logger> & { broadcast: Broadcast }
export function defineJob<
  const Name extends string,
  Payload extends object,
  const Queue extends string = string,
  Env = unknown,
  Db = unknown,
  Logger = unknown,
>(
  opts: DefineJobBaseOptions<Name, Payload, Queue, Env, Db, Logger>
    & { broadcast?: JobBroadcastDefinition<Payload, Env> },
): JobDefinition<Name, Payload, Queue, Env, Db, Logger>
export function defineJob(opts: any): any {
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

export function validateJobDefinitions(
  jobs: readonly unknown[],
): JobDefinitionValidationIssue[] {
  const issues: JobDefinitionValidationIssue[] = []
  const seen = new Set<string>()

  for (const job of jobs) {
    if (!job || typeof job !== 'object') {
      issues.push({ name: '<unknown>', reason: 'invalid-definition' })
      continue
    }

    const definition = job as Partial<AnyJobDefinition> & Partial<LazyJobEntry>
    const name = typeof definition.name === 'string' && definition.name.length > 0
      ? definition.name
      : '<unknown>'

    // Lazy entries carry `load` instead of `handle`; either satisfies the shape.
    if (
      typeof definition.name !== 'string'
      || definition.name.length === 0
      || (typeof definition.handle !== 'function' && typeof definition.load !== 'function')
    ) {
      issues.push({ name, reason: 'invalid-definition' })
    }

    if (typeof definition.queue !== 'string' || definition.queue.length === 0)
      issues.push({ name, reason: 'invalid-queue' })

    if (seen.has(name))
      issues.push({ name, reason: 'duplicate-name' })
    seen.add(name)
  }

  return issues
}

export function assertJobDefinitions(jobs: readonly unknown[]): void {
  const issues = validateJobDefinitions(jobs)
  if (issues.length === 0)
    return

  const details = issues
    .map(issue => `${issue.name}: ${issue.reason}`)
    .join(', ')
  throw new Error(`Invalid nuxt-cf-jobs registry: ${details}`)
}

export function defineJobRegistry<
  const Jobs extends readonly AnyJobDefinition[],
>(jobs: Jobs) {
  assertJobDefinitions(jobs)

  // Entries are typed as `AnyJobDefinition[]` for the precise method signatures,
  // but at runtime the generated app passes lazy entries (metadata + `load`);
  // treat them as `RegistryEntry` for the lazy-aware branches below.
  const entries = jobs as readonly RegistryEntry[]
  const byName = new Map<string, RegistryEntry>(entries.map(job => [job.name, job]))
  // Caches the loaded full definition of a lazy entry (one import per job).
  const loaded = new Map<string, Promise<AnyJobDefinition>>()

  function loadJobDefinition<Name extends JobNameOf<Jobs>>(name: Name): Promise<JobDefinitionByName<Jobs, Name> | undefined>
  function loadJobDefinition(name: string): Promise<AnyJobDefinition | undefined>
  function loadJobDefinition(name: string): Promise<AnyJobDefinition | undefined> {
    const entry = byName.get(name)
    if (!entry)
      return Promise.resolve(undefined)
    if (!isLazyJobEntry(entry))
      return Promise.resolve(entry)
    let pending = loaded.get(name)
    if (!pending) {
      pending = entry.load()
      loaded.set(name, pending)
    }
    return pending
  }

  // Never loads a module. Eager defs are returned whole (they already hold
  // `input`/`unique`/`uniqueId` in memory, so producer-side validation + dedup
  // keep working); lazy entries return static routing metadata only — typed as a
  // full definition for callers, but `handle`/`input` are absent at runtime (the
  // real module materializes at dispatch or durable preparation via
  // `loadJobDefinition`).
  function getJobDefinition<Name extends JobNameOf<Jobs>>(name: Name): JobDefinitionByName<Jobs, Name> | undefined
  function getJobDefinition(name: string): AnyJobDefinition | undefined
  function getJobDefinition(name: string) {
    const entry = byName.get(name)
    if (!entry)
      return undefined
    return (isLazyJobEntry(entry) ? toStaticDefinition(entry) : entry) as AnyJobDefinition
  }

  function getJobQueue<Name extends JobNameOf<Jobs>>(name: Name): JobQueueByName<Jobs, Name> | undefined
  function getJobQueue(name: string): string | undefined
  function getJobQueue(name: string) {
    return byName.get(name)?.queue
  }

  // Sync for eager defs (tests / direct use), async for lazy entries. Callers
  // (`dispatchRegisteredJob`) await it, which is a no-op on the sync path.
  function getHandler(name: string): JobHandler<unknown, unknown, unknown, unknown> | Promise<JobHandler<unknown, unknown, unknown, unknown> | undefined> | undefined {
    const entry = byName.get(name)
    if (!entry)
      return undefined
    if (!isLazyJobEntry(entry))
      return entry.handle as JobHandler<unknown, unknown, unknown, unknown>
    return loadJobDefinition(name).then(def => def?.handle as JobHandler<unknown, unknown, unknown, unknown> | undefined)
  }

  return {
    jobs,
    getHandler,
    loadJobDefinition,
    getJobDefinition,
    getJobQueue,
    buildPayload<Name extends JobNameOf<Jobs>>(
      name: Name,
      payload: JobPayloadByName<Jobs, Name>,
    ): { _task: Name } & JobPayloadByName<Jobs, Name> {
      const entry = byName.get(name)
      if (!entry)
        throw new Error(`Unknown task: ${name}`)
      // Eager defs validate via their `input` schema; lazy entries have no schema
      // here (it lives in the unloaded module), so validation defers to dispatch.
      const definition = isLazyJobEntry(entry) ? toStaticDefinition(entry) : entry
      return buildJobMessage(definition as JobDefinitionByName<Jobs, Name>, payload) as { _task: Name } & JobPayloadByName<Jobs, Name>
    },
    getJobRoute(name: string) {
      const entry = byName.get(name)
      return entry ? { queue: entry.queue as string, jobType: entry.jobType ?? entry.name } : undefined
    },
    validate(expectedTasks: readonly string[]) {
      const registered = new Set(byName.keys())
      const expected = new Set(expectedTasks)
      return {
        missing: expectedTasks.filter(task => !registered.has(task)),
        extra: [...registered].filter(task => !expected.has(task)),
      }
    },
  }
}
