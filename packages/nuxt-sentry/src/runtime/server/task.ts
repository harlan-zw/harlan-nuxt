import type { ReportingTask, TaskLike } from '../shared/task'
import { captureException, setContext, withScope } from '@sentry/cloudflare'
import { withTaskReporting } from '../shared/task'

/**
 * Reports a Nitro scheduled task's failures to Sentry.
 *
 * Wrap the definition a task exports:
 *
 * ```ts
 * export default withSentryTask(defineTask({
 *   meta: { name: 'my:cron' },
 *   async run() { ... },
 * }))
 * ```
 *
 * The Nitro plugin cannot do this for you. Nitro's `runTask` calls no hook, so
 * nothing in a plugin can see a task run, and on Cloudflare a throwing task
 * rejects the scheduled handler and reaches Sentry, if at all, as an
 * unattributed `scriptThrewException`.
 *
 * The error is rethrown, so the scheduler still sees the task fail.
 */
export function withSentryTask<Result>(task: TaskLike<Result>): ReportingTask<Result> {
  return withTaskReporting(task, ({ error, tags, context }) => {
    withScope((scope) => {
      scope.setTags(tags)
      setContext('nitro_task', context.nitro_task)
      captureException(error)
    })
  })
}
