/**
 * Types shared by the build half and the runtime half of the module.
 *
 * Everything here must survive `JSON.stringify`, because the resolved Report
 * Policy travels to the client and the server through `runtimeConfig`. That
 * rules out a live `RegExp`, so a pattern is carried as `SerializedPattern` and
 * rebuilt once at the runtime boundary.
 */

/** A `RegExp` in a shape `runtimeConfig` can carry. */
export interface SerializedPattern {
  _tag: 'pattern'
  source: string
  flags: string
}

/** A literal message match, compared case sensitively as a substring. */
export interface LiteralPattern {
  _tag: 'literal'
  value: string
}

export type MessagePattern = SerializedPattern | LiteralPattern

/** An inclusive HTTP status range. A single status is `{ from: n, to: n }`. */
export interface StatusRange {
  from: number
  to: number
}

/**
 * Where an Error Report was captured. The two scopes share every rule except
 * the status list, so the rule functions take the scope rather than being
 * written twice.
 */
export type ReportScope = 'client' | 'server'

/**
 * How much of the request an Error Report carries.
 *
 * `none` sends no personal data at all, so no Redaction Rule can be needed.
 * `scrubbed` sends the request and then runs every Redaction Rule over it.
 */
export type DataCollection = 'none' | 'scrubbed'

/** The resolved Report Policy for one scope. Pure data. */
export interface ReportPolicy {
  scope: ReportScope
  dataCollection: DataCollection
  /** Statuses that never produce an Error Report. */
  dropStatus: StatusRange[]
  /** Drop `TimeoutError`, `AbortError` and the abort message patterns. */
  dropTransient: boolean
  /** Messages that never produce an Error Report. */
  ignoreErrors: MessagePattern[]
  /** Source URLs that never produce an Error Report. */
  denyUrls: SerializedPattern[]
  /** Extra key names every Redaction Rule treats as secret. */
  secretKeys: string[]
}

/** Environment naming. The server has no hostname, so it always takes `fallback`. */
export interface EnvironmentPolicy {
  fallback: string
  /** Host prefix to environment name. Checked in order. */
  hostPrefixes: Array<{ prefix: string, name: string }>
}

/** Trace sampling. A record is keyed by resolved environment name. */
export interface SampleRatePolicy {
  fallback: number
  byEnvironment: Record<string, number>
}

/** Why a build sends no Error Report. Each reason names one gate that failed. */
export type ReportDisabledReason
  = | 'option'
    | 'no-dsn'
    | 'not-production'
    | 'no-release'
    | 'not-ci'
    | 'local-host'

/**
 * Whether this build may send an Error Report, and under what identity.
 *
 * Resolved once at build time, serialised into `runtimeConfig.nuxtSentry`, and
 * read by both plugins. One resolution replaces the five different enable gates
 * the sites wrote separately.
 */
export type ReportTarget
  = | { _tag: 'disabled', reason: ReportDisabledReason }
    | {
      _tag: 'enabled'
      dsn: string
      release: string
      environment: EnvironmentPolicy
      tracesSampleRate: SampleRatePolicy
      /** The `app` tag, or `null` when one Sentry project serves one deployment. */
      app: string | null
      /** Forward `console.warn` and `console.error` to Sentry Logs. */
      logs: boolean
      /** Cloudflare binding holding the Worker version, or `null` when off. */
      workerVersionBinding: string | null
    }

/** The whole resolved module state, as it sits in `runtimeConfig.nuxtSentry`. */
export interface SentryRuntimeConfig {
  target: ReportTarget
  client: ReportPolicy
  server: ReportPolicy
}

/**
 * The subset of a Sentry event this module reads or rewrites.
 *
 * Structural on purpose. `@sentry/cloudflare`, `@sentry/node` and the browser
 * SDK each declare their own `Event`, and all three satisfy this shape, so the
 * policy core couples to none of them.
 */
export interface ErrorReport {
  message?: string
  exception?: {
    values?: Array<{
      type?: string
      value?: string
      stacktrace?: { frames?: Array<{ filename?: string }> }
    }>
  }
  breadcrumbs?: Array<{
    category?: string
    message?: string
    data?: Record<string, unknown>
  }> | null
  user?: Record<string, unknown>
  request?: {
    url?: string
    cookies?: unknown
    query_string?: unknown
    headers?: Record<string, unknown>
    data?: unknown
  }
  extra?: Record<string, unknown>
  contexts?: Record<string, unknown>
  tags?: Record<string, unknown>
}

/** What Sentry hands `beforeSend` alongside the report. */
export interface ErrorReportHint {
  originalException?: unknown
}

/** The outcome of every Drop Rule, run in order. */
export type ReportDecision
  = | { _tag: 'send' }
    | { _tag: 'drop', rule: DropRuleName }

export type DropRuleName
  = | 'status'
    | 'transient'
    | 'ignore-message'
    | 'deny-url'
