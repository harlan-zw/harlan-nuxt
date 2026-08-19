import type { PolicyOptions } from './build/policy'
import type { ReportGate } from './build/target'
import type { WideEventsOption } from './build/wide-events'
import type { DataCollection } from './runtime/shared/types'

export interface ModuleOptions {
  /**
   * Register anything at all. Set false to remove the module without editing
   * the rest of the config.
   * @default true
   */
  enabled?: boolean

  /**
   * The public Sentry DSN. Required. It ships in the client bundle, so it is
   * not a secret.
   */
  dsn: string

  /**
   * Sentry organisation slug, used by the build plugin.
   * @default 'harlan-zw'
   */
  org?: string

  /** Sentry project slug, used by the build plugin. Required when `sourceMaps` is on. */
  project?: string

  /**
   * A short label attached to every Error Report as the `app` tag. Set it when
   * one Sentry organisation serves more than one deployment of the same
   * codebase.
   */
  app?: string

  /**
   * Who may send an Error Report.
   *
   * `release` requires a production build that carries a release identity.
   * `ci` requires a production build produced in CI.
   * `always` allows any production build.
   *
   * @default 'release'
   */
  gate?: ReportGate

  /**
   * Environment name attached to every Error Report.
   *
   * A string is used as is. A record maps a host prefix to a name, so
   * `{ 'staging.': 'staging' }` splits a staging deployment from production
   * without a second project. `SENTRY_ENVIRONMENT` overrides both.
   *
   * @default 'production'
   */
  environment?: string | Record<string, string>

  /**
   * Fraction of requests traced, 0 to 1. A record keyed by environment name
   * sets a rate per environment.
   * @default 0.05
   */
  tracesSampleRate?: number | Record<string, number>

  /**
   * How much of the request an Error Report carries.
   *
   * `scrubbed` sends the request and then applies every Redaction Rule.
   * `none` sends no personal data at all.
   *
   * @default 'scrubbed'
   */
  dataCollection?: DataCollection

  /** Report Policy. */
  policy?: PolicyOptions

  /**
   * Emit and upload client source maps when a Sentry auth token is present, and
   * delete them after upload. Also strips Session Replay from the bundle.
   * @default true
   */
  sourceMaps?: boolean

  /**
   * Forward `console.warn` and `console.error` to Sentry Logs.
   *
   * Off by default. Sentry meters logs as their own byte quota, separate from
   * the error quota, so turning this on costs money a site must choose to spend.
   *
   * @default false
   */
  logs?: boolean

  /**
   * Attach the Cloudflare Worker version as tags and context, read from the
   * named binding. `false` disables it. Only takes effect on a Cloudflare
   * deployment.
   * @default 'CF_VERSION_METADATA'
   */
  workerVersionBinding?: string | false

  /**
   * Forward failing Wide Events to Sentry Logs.
   *
   * `true` forwards a Wide Event whose level is `error`. Pass
   * `{ levels: ['warn', 'error'] }` to widen it. Sentry meters Logs as their own
   * byte quota, so every added level costs money a site must choose to spend.
   *
   * Inert when `@harlan-zw/nuxt-wide-events` is absent or its `drain` option is
   * off. Requires `logs` to be on, because a Wide Event is sent as a log.
   *
   * @default false
   */
  wideEvents?: WideEventsOption
}
