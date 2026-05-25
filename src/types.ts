export interface QueueBindingOptions {
  binding: string
  queueName?: string
  jobType?: string
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
  orphanedJobThresholdSeconds: number
}
