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

export interface BroadcastOptions {
  /**
   * Register the Nitro WebSocket endpoint and publish its route to app runtime
   * config. Use `cfJobs.broadcast: true` for defaults.
   */
  enabled?: boolean
  /** WebSocket endpoint used by app composables. Defaults to `/__cf-jobs/ws`. */
  route?: string
  /** Durable Object namespace binding used by server broadcast helpers. */
  durableObjectBinding?: string
  /** Durable Object instance name. Defaults to Nitro's central `server` object. */
  durableObjectName?: string
}

export interface ReconcileOptions {
  /**
   * Disable the module-owned recovery task when an app already owns durable job
   * recovery. Defaults to enabled.
   */
  enabled?: boolean
  /** D1 binding that owns the durable jobs tables. Defaults to auto-detect. */
  d1Binding?: string
  /**
   * Reserved jobs older than this are released for retry. Defaults to 900s.
   *
   * This is the row's ownership window. The durable consumer's
   * `reclaimAfterSeconds` defaults to this same value, so a redelivery and the
   * reaper agree on when a reservation is abandoned. Set it above your longest
   * handler runtime: a shorter window releases a job that is still running.
   */
  staleSeconds?: number
  /**
   * Due, unreserved jobs older than this are treated as orphaned. Defaults to 6h.
   *
   * The orphan test cannot tell "the dispatch was lost" from "dispatched fine,
   * still queued", so keep this above the worst queue wait. On a
   * `max_concurrency: 1` consumer that wait is hours.
   */
  orphanedSeconds?: number
  /**
   * Minimum gap between two sweep re-dispatches of the SAME row. Defaults to
   * `orphanedSeconds`.
   *
   * The sweep measures it from the row's last successful dispatch
   * (`last_dispatched_at`), so a row that is merely waiting its turn is never
   * re-sent inside this window.
   */
  redispatchGraceSeconds?: number
  /** Grace for the original CF redelivery before reconcile sends a duplicate. Defaults to 120s. */
  redeliveryGraceSeconds?: number
  /** Pending batches with no active jobs older than this are closed. Defaults to 7 days. */
  orphanedBatchSeconds?: number
  /** Max stale/orphaned rows handled per cron tick. Defaults to 100. */
  limit?: number
  /**
   * Application module exporting `createReconcileJobContext`. This lets the
   * stale reaper invoke a job definition's `failed` callback after durable
   * terminal evidence has been committed. Relative paths resolve from rootDir.
   */
  terminalFailureContext?: string
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
   * Where to find default-exported `defineJob` definitions.
   *
   * - `true` — auto-discover `server/jobs` in the app and **every extended
   *   layer** (`nuxt.options._layers`), the same rule as `tasksDir: true`.
   * - `string | string[]` — explicit dirs, resolved from the Nuxt root.
   * - unset — `server/jobs` in the app only.
   * - `false` — no discovery; only jobs contributed through the
   *   `cf-jobs:registry:sources` hook are registered.
   */
  jobsDir?: string | string[] | boolean
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
   * Where to find `defineScheduledTask` (and plain nitro `defineTask`) default
   * exports. Each discovered file is registered in `nitro.tasks` keyed by its
   * declared `name`; files that declare a `cron` are also wired into
   * `nitro.scheduledTasks` and the Cloudflare cron triggers.
   *
   * - `true` — auto-discover `server/tasks` in the app and **every extended
   *   layer** (`nuxt.options._layers`). Adding a layer with scheduled tasks
   *   then needs no host config change at all.
   * - `string | string[]` — explicit dirs, resolved from the Nuxt root.
   * - unset / `false` — disabled (opt-in; nothing is scanned or registered).
   *
   * This replaces hand-maintaining `nitro.tasks` + `nitro.scheduledTasks` +
   * `nitro.cloudflare.wrangler.triggers.crons` in `nuxt.config`.
   */
  tasksDir?: string | string[] | boolean
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
   * Opt-in Laravel-style broadcasting over Nitro WebSockets. The route is
   * transport-only: apps can deny subscriptions with the
   * `cf-jobs:broadcast:authorize` Nitro hook when channels are private.
   */
  broadcast?: boolean | BroadcastOptions
  /**
   * Module-owned durable job recovery backstop. Enabled by default so persisted
   * jobs recover if queue sends are missed or a worker dies while reserved.
   */
  reconcile?: boolean | ReconcileOptions
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
