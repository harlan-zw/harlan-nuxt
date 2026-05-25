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
