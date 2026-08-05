import type { JobRegistryLike } from './dispatch'
import type { DurableJobTerminalized } from './outbox'
import type { DispatchableJob, JobContext, JobControlResult } from './types'
import { parseJobInput } from './registry'

export interface ReconcileTerminalFailureContextInput<Env extends Record<string, unknown>> {
  env: Env
  terminalized: DurableJobTerminalized
  job: DispatchableJob
  taskName: string
  payload: Record<string, unknown>
  control: JobControlResult
}

export type ReconcileTerminalFailureContextFactory<Env extends Record<string, unknown>, Db, Logger>
  = (input: ReconcileTerminalFailureContextInput<Env>) => JobContext<Env, Db, Logger> | Promise<JobContext<Env, Db, Logger>>

export type ReconcileTerminalFailureResult
  = { _tag: 'handled', taskName: string }
    | { _tag: 'no-failed-handler', taskName: string }
    | { _tag: 'context-unavailable', taskName: string }

export async function runTerminalizedJobFailure<Env extends Record<string, unknown>, Db, Logger>(opts: {
  env: Env
  registry: JobRegistryLike<Env, Db, Logger>
  terminalized: DurableJobTerminalized
  createContext?: ReconcileTerminalFailureContextFactory<Env, Db, Logger>
}): Promise<ReconcileTerminalFailureResult> {
  const envelope = parseTerminalizedPayload(opts.terminalized)
  const taskName = envelope._task
  const definition = opts.registry.loadJobDefinition
    ? await opts.registry.loadJobDefinition(taskName)
    : opts.registry.getJobDefinition?.(taskName)
  if (!definition)
    throw new Error(`Terminalized job references unknown task: ${taskName}`)
  if (!definition.failed)
    return { _tag: 'no-failed-handler', taskName }
  if (!opts.createContext)
    return { _tag: 'context-unavailable', taskName }

  const { _task, _continuations, ...cleanPayload } = envelope
  const parsed = parseJobInput(definition as never, cleanPayload)
  if (!parsed.success)
    throw new Error(`Terminalized job payload no longer matches task: ${taskName}`, { cause: parsed.error })

  const control: JobControlResult = { handled: false }
  const job: DispatchableJob = {
    id: opts.terminalized.id,
    queue: opts.terminalized.queue,
    payload: envelope,
    attempts: opts.terminalized.attempts,
    batchId: opts.terminalized.batchId,
    siteId: null,
    userId: null,
  }
  const payload = parsed.data as Record<string, unknown>
  const context = await opts.createContext({
    env: opts.env,
    terminalized: opts.terminalized,
    job,
    taskName,
    payload,
    control,
  })
  await definition.failed(payload, context, new Error(opts.terminalized.exception))
  return { _tag: 'handled', taskName }
}

function parseTerminalizedPayload(terminalized: DurableJobTerminalized): Record<string, unknown> & { _task: string } {
  let value: unknown
  try {
    value = JSON.parse(terminalized.payload)
  }
  catch (cause) {
    throw new Error(`Terminalized job has invalid JSON payload: ${terminalized.id}`, { cause })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as { _task?: unknown })._task !== 'string')
    throw new Error(`Terminalized job payload is missing _task: ${terminalized.id}`)
  return value as Record<string, unknown> & { _task: string }
}
