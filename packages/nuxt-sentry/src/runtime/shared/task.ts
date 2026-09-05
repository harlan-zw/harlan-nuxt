/**
 * Error reporting for Nitro scheduled tasks.
 *
 * The Nitro plugin covers requests. It wraps `nitroApp.localFetch` and hooks
 * Nitro's `error` event, and a scheduled task goes through neither: Nitro's
 * `runTask` calls no hook at all, so a plugin cannot observe one. On the
 * Cloudflare path `runCronTasks` awaits the tasks with no catch of its own, so
 * a task that throws rejects the Worker's scheduled handler and the failure
 * arrives as `scriptThrewException`, carrying no task name and no stack.
 *
 * Nitro exposes no hook to fix that centrally, so reporting is a wrapper the
 * task opts into. This file decides what a failure looks like and holds no
 * Sentry reference, which keeps the decision testable without one.
 */

/** What Nitro hands a task when it runs one. */
export interface TaskRunContext {
  name?: string
  payload?: Record<string, unknown>
  context?: Record<string, unknown>
}

/** The minimum shape of a Nitro task, kept structural so no Nitro type is imported. */
export interface TaskLike<Result = unknown> {
  meta?: { name?: string, description?: string }
  run: (context: TaskRunContext) => Promise<Result> | Result
}

/**
 * A wrapped task.
 *
 * `run` always accepts the context, even when the task it wraps declared no
 * parameter, so Nitro can call it the same way either way.
 */
export interface ReportingTask<Result = unknown> {
  meta?: { name?: string, description?: string }
  run: (context?: TaskRunContext) => Promise<Result>
}

/** What a caller sends to Sentry for a failed task. */
export interface TaskFailureReport {
  error: unknown
  tags: { task: string }
  context: { nitro_task: { name: string } }
}

/** Captures a task failure. Sentry's `captureException` shape, so the real one drops in. */
export type CaptureTaskFailure = (report: TaskFailureReport) => void

/** The name to report a task under, preferring its own declared name. */
export function resolveTaskName(task: TaskLike, fallback?: string): string {
  return task.meta?.name || fallback || 'unknown'
}

/**
 * Describes a failed task in the shape a report needs.
 *
 * The name becomes a tag as well as context, because a tag is what makes the
 * failures of one task searchable as a group.
 */
export function describeTaskFailure(name: string, error: unknown): TaskFailureReport {
  return {
    error,
    tags: { task: name },
    context: { nitro_task: { name } },
  }
}

/**
 * Wraps a task so a throw is reported before it leaves.
 *
 * The error is rethrown. Reporting must not change what the platform sees,
 * because a task that swallows its own failure stops the scheduler from
 * retrying and hides the outage from anything watching exit status.
 *
 * A capture that itself fails is ignored on purpose: losing the report is bad,
 * and replacing the task's real error with a reporting error is worse.
 */
export function withTaskReporting<Result>(
  task: TaskLike<Result>,
  capture: CaptureTaskFailure,
): ReportingTask<Result> {
  return {
    ...(task.meta ? { meta: task.meta } : {}),
    run: async (context) => {
      try {
        return await task.run(context ?? {})
      }
      catch (error) {
        try {
          capture(describeTaskFailure(resolveTaskName(task, context?.name), error))
        }
        catch {
          // Reporting is best effort. The task's own error is the one that matters
          // and it is rethrown below either way.
        }
        throw error
      }
    },
  }
}
