export interface QueueBindingOptions {
  binding: string
  queueName?: string
  jobType?: string
  maxBatchSize?: number
  maxBatchTimeout?: number
  maxConcurrency?: number
  maxRetries?: number
  retryDelay?: number
  /** Cloudflare queue name of the DLQ (mirrors wrangler `dead_letter_queue`). */
  deadLetterQueue?: string
  /** Binding name of the DLQ producer so the module can forward exhausted messages. */
  deadLetterQueueBinding?: string
}

export interface ModuleOptions {
  /**
   * Logical queue name -> Cloudflare env binding name.
   *
   * Example:
   * {
   *   "lh-scans": "QUEUE_LH_SCANS",
   *   "sync-critical": { binding: "SYNC_CRITICAL", jobType: "sync" }
   * }
   */
  queues: Record<string, string | QueueBindingOptions>
  /**
   * Logical queue name used when a job omits `queue` on its `defineJob` call.
   * Must be a key of `queues`.
   */
  defaultQueue?: string
  /**
   * Directories scanned at build/dev time for default-exported job definitions.
   * Relative paths are resolved from the Nuxt root directory.
   */
  jobsDir?: string | string[]
  /**
   * Glob pattern used inside each jobsDir.
   */
  jobsPattern?: string | string[]
  /**
   * Extra glob ignore patterns for jobsDir scanning.
   */
  jobsIgnore?: string[]
  /**
   * Alias for the generated typed registry module.
   */
  registryAlias?: string
  /**
   * Directories scanned at build/dev time for `defineScheduledTask` (and plain
   * nitro `defineTask`) default exports. Each discovered file is registered in
   * `nitro.tasks` keyed by its declared `name`; files that declare a `cron` are
   * also wired into `nitro.scheduledTasks` and the Cloudflare cron triggers.
   * Relative paths are resolved from the Nuxt root directory.
   *
   * This replaces hand-maintaining `nitro.tasks` + `nitro.scheduledTasks` +
   * `nitro.cloudflare.wrangler.triggers.crons` in `nuxt.config`.
   */
  tasksDir?: string | string[]
  /**
   * Glob pattern used inside each tasksDir. Defaults to `'**\/*.ts'`.
   */
  tasksPattern?: string | string[]
  /**
   * Extra glob ignore patterns for tasksDir scanning.
   */
  tasksIgnore?: string[]
  /**
   * Whether to populate `nitro.scheduledTasks` (and thus fire crons via
   * croner/Cloudflare) from discovered tasks.
   * - `undefined` (default): enabled only when NOT in dev — mirrors the common
   *   `NODE_ENV === 'production' ? {...} : {}` gate so crons don't fire locally.
   * - `true`: always populate (crons fire in dev too).
   * - `false`: never populate (handlers are still registered for manual runs).
   *
   * The Cloudflare `triggers.crons` deploy metadata is always written regardless
   * of this flag (it only takes effect on deploy).
   */
  scheduledTasks?: boolean
  /**
   * Cross-check the user's wrangler config against `queues` at build time
   * and emit `.nuxt/cf-jobs/wrangler.suggested.toml`. Defaults to `true`.
   */
  validateWrangler?: boolean
  /**
   * Override the wrangler config path (relative to rootDir).
   * Defaults to scanning for `wrangler.jsonc`, `wrangler.json`, `wrangler.toml`.
   */
  wranglerPath?: string
}
