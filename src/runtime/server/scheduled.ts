import type { Task } from 'nitropack/types'
import { defineTask } from 'nitropack/runtime'

export interface ScheduledTaskDefinition<RT = unknown> {
  /**
   * Globally-unique task name (the key nitro registers in `nitro.tasks` and the
   * id used by `runTask(name)`). Must be a string literal so nuxt-cf-jobs can
   * read it at build time without executing the file.
   */
  name: string
  /**
   * Cron expression(s) the task runs on. Cloudflare / croner syntax. Must be a
   * string literal (or array of string literals) for the same build-time reason.
   * The module derives `nitro.scheduledTasks` and the wrangler `triggers.crons`
   * union from these.
   */
  cron: string | string[]
  /** Human description surfaced in nitro devtools. */
  description?: string
  run: Task<RT>['run']
}

/**
 * Declare a cron-scheduled nitro task with its schedule co-located. Returns a
 * plain nitro task (so the file's default export is a valid task handler); the
 * `name` + `cron` are also read statically at build time by the nuxt-cf-jobs
 * module to wire `nitro.tasks`, `nitro.scheduledTasks`, and the Cloudflare cron
 * triggers — no central list to keep in sync.
 */
export function defineScheduledTask<RT = unknown>(def: ScheduledTaskDefinition<RT>): Task<RT> {
  return defineTask<RT>({
    meta: { name: def.name, description: def.description },
    run: def.run,
  })
}
