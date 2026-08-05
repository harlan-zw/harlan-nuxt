import type {
  DispatchableJob,
  DispatchResult,
  JobContext,
  JobControlResult,
  JobDefinition,
  JobHandler,
  JobMiddleware,
} from './types'
import { jobErrors } from './errors'
import { parseJobInput } from './registry'

export interface JobRegistryLike<Env, Db, Logger> {
  /** May resolve asynchronously for lazily-loaded jobs; callers must await. */
  getHandler: (name: string) => JobHandler<unknown, Env, Db, Logger> | undefined | Promise<JobHandler<unknown, Env, Db, Logger> | undefined>
  /**
   * Returns the definition for routing/validation. For lazy entries this is
   * static routing metadata typed as a full definition (its `handle`/`input` are
   * absent at runtime); dispatch prefers `loadJobDefinition` for the real module.
   */
  getJobDefinition?: (name: string) => JobDefinition<string, unknown, string, Env, Db, Logger> | undefined
  /**
   * Loads the full definition (handler, `input`, `middleware`, `failed`) for a
   * lazy entry. Preferred at dispatch so payload validation + failure hooks see
   * the real module. Falls back to `getJobDefinition`/`getHandler` when absent.
   */
  loadJobDefinition?: (name: string) => Promise<JobDefinition<string, unknown, string, Env, Db, Logger> | undefined>
}

export interface DispatchContextInput<Job extends DispatchableJob> {
  job: Job
  taskName: string
  payload: Record<string, unknown>
  control: JobControlResult
}

export interface DispatchRegisteredJobOptions<Job extends DispatchableJob, Env, Db, Logger> {
  registry: JobRegistryLike<Env, Db, Logger>
  job: Job
  createContext: (input: DispatchContextInput<Job>) => JobContext<Env, Db, Logger> | Promise<JobContext<Env, Db, Logger>>
  onHandledThrow?: (input: DispatchContextInput<Job> & { error: unknown }) => void | Promise<void>
  onUnhandledThrow?: (input: DispatchContextInput<Job> & { error: unknown }) => void | Promise<void>
  onComplete?: (input: DispatchContextInput<Job>) => void | Promise<void>
}

export async function dispatchRegisteredJob<Job extends DispatchableJob, Env, Db, Logger>(
  opts: DispatchRegisteredJobOptions<Job, Env, Db, Logger>,
): Promise<DispatchResult> {
  const payload = opts.job.payload as { _task?: unknown, [key: string]: unknown }
  const taskName = payload._task

  if (typeof taskName !== 'string' || taskName.length === 0) {
    return { success: false, error: jobErrors.noTask() }
  }

  // Prefer the fully-loaded definition (carries `input`/`middleware`/`failed`/
  // `handle`); fall back to static metadata + a separate handler lookup for
  // registries that don't implement lazy loading.
  const definition = opts.registry.loadJobDefinition
    ? await opts.registry.loadJobDefinition(taskName)
    : opts.registry.getJobDefinition?.(taskName)
  const handler = definition?.handle ?? await opts.registry.getHandler(taskName)
  if (!handler) {
    return { success: false, error: jobErrors.handlerNotFound(taskName) }
  }

  const { _task, _continuations, ...cleanPayload } = payload
  const parsedPayload = parseJobInput(definition as never, cleanPayload)
  if (!parsedPayload.success) {
    return { success: false, error: jobErrors.invalidPayload(taskName, parsedPayload.error) }
  }

  const control: JobControlResult = { handled: false }
  const input: DispatchContextInput<Job> = {
    job: opts.job,
    taskName,
    payload: parsedPayload.data as Record<string, unknown>,
    control,
  }
  const ctx = await opts.createContext(input)

  try {
    await runJobThroughMiddleware(
      parsedPayload.data,
      ctx,
      definition?.middleware ?? [],
      () => handler(parsedPayload.data, ctx),
    )
  }
  catch (error) {
    if (control.handled) {
      await opts.onHandledThrow?.({ ...input, error })
      return { success: true, control }
    }
    await opts.onUnhandledThrow?.({ ...input, error })
    throw error
  }

  await opts.onComplete?.(input)
  return { success: true, control: control.handled ? control : undefined }
}

export async function runJobThroughMiddleware<Payload, Env, Db, Logger>(
  payload: Payload,
  ctx: JobContext<Env, Db, Logger>,
  middleware: Array<JobMiddleware<Payload, Env, Db, Logger>>,
  destination: () => Promise<void>,
): Promise<void> {
  let index = -1

  async function run(i: number): Promise<void> {
    if (i <= index)
      throw new Error('Job middleware called next() multiple times')
    index = i
    const layer = middleware[i]
    if (!layer)
      return destination()
    await layer(payload, ctx, () => run(i + 1))
  }

  await run(0)
}
