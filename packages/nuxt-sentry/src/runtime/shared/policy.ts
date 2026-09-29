import type {
  DataCollection,
  EnvironmentPolicy,
  ErrorReport,
  ErrorReportHint,
  ReportDisabledReason,
  ReportPolicy,
  ReportTarget,
  SampleRatePolicy,
} from './types'
import { compilePattern, decideReport } from './drop'
import { redactErrorReport } from './redact'

/**
 * The Report Policy applied to one Error Report.
 *
 * Pure data in, pure data out. `beforeSend` is the only effectful edge, and it
 * does nothing but return this function's result to Sentry.
 */
export function applyReportPolicy<T extends ErrorReport>(
  report: T,
  hint: ErrorReportHint | undefined,
  policy: ReportPolicy,
): T | null {
  const decision = decideReport(report, hint?.originalException, policy)
  if (decision._tag === 'drop')
    return null
  // Redaction runs on every report, under both `dataCollection` settings.
  // Under `'none'` the request fields are absent, so only the free text rules
  // do any work, and those still matter: ofetch quotes the failing URL into the
  // error message, query string and all, which no data collection setting
  // suppresses.
  return redactErrorReport(report, policy.secretKeys)
}

/** The `beforeSend` a Sentry client is initialised with. */
export function createBeforeSend(policy: ReportPolicy) {
  return <T extends ErrorReport>(report: T, hint?: ErrorReportHint): T | null =>
    applyReportPolicy(report, hint, policy)
}

/**
 * The `ignoreErrors` and `denyUrls` the browser SDK is initialised with.
 *
 * The SDK matches these before `beforeSend` runs, so passing them here drops
 * the report earlier and cheaper. The same patterns still sit in the policy, so
 * the server, which has no such SDK option, gets the identical decision.
 */
export function createClientNoiseOptions(policy: ReportPolicy): {
  ignoreErrors: Array<string | RegExp>
  denyUrls: RegExp[]
} {
  return {
    ignoreErrors: policy.ignoreErrors.map(entry => entry._tag === 'literal'
      ? entry.value
      : compilePattern(entry)),
    denyUrls: policy.denyUrls.map(compilePattern),
  }
}

/**
 * The Sentry `dataCollection` option for a `DataCollection` setting.
 *
 * Both settings pass an explicit object, because the SDK default moved.
 * Sentry 10 collected little when the option was unset. Sentry 11 collects
 * every category when it is unset, and removed `sendDefaultPii`. An explicit
 * object resolves the same on both majors.
 *
 * `scrubbed` names every category Sentry 10 enabled for `sendDefaultPii: true`.
 * `none` turns every personal category off.
 *
 * Both settings turn off `queues`. Sentry 11 added that category and collects
 * queue message payloads by default. Sentry 10 never sent them, and no
 * Redaction Rule reads a span, so neither setting may start. Sentry 10 ignores
 * the key.
 */
export function createSentryDataCollection(setting: DataCollection) {
  if (setting === 'scrubbed') {
    return {
      userInfo: true,
      cookies: true,
      httpHeaders: { request: true, response: true },
      httpBodies: ['incomingRequest', 'outgoingRequest', 'incomingResponse', 'outgoingResponse'] as HttpBodyCollectionTarget[],
      urlQueryParams: true,
      graphQL: { document: true, variables: true },
      genAI: { inputs: true, outputs: true },
      databaseQueryData: true,
      queues: false,
      stackFrameVariables: true,
    }
  }
  return {
    userInfo: false,
    cookies: false,
    httpHeaders: { request: false, response: false },
    httpBodies: [] as HttpBodyCollectionTarget[],
    urlQueryParams: false,
    graphQL: { document: false, variables: false },
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
    stackFrameVariables: false,
  }
}

type HttpBodyCollectionTarget = 'incomingRequest' | 'outgoingRequest' | 'incomingResponse' | 'outgoingResponse'

export interface SentryInitOptionsInput {
  /** `SDK_VERSION` from the Sentry package that starts the client. */
  sdkVersion: string
  dataCollection: DataCollection
  /** Whether a logging integration is installed. */
  logs: boolean
}

/**
 * The `Sentry.init` options that keep one meaning on Sentry 10 and Sentry 11.
 *
 * Sentry 10 drops every log unless `enableLogs` is set. Sentry 11 removed that
 * option and sends logs whenever a logging integration is installed.
 *
 * Sentry 11 also attaches a synthetic stack to a message or a thrown non Error
 * by default. That stack would stop `dropStacklessErrors` from matching, and
 * split issue groups, so `attachStacktrace` stays at the Sentry 10 default.
 */
export function createSentryInitOptions(input: SentryInitOptionsInput) {
  return {
    dataCollection: createSentryDataCollection(input.dataCollection),
    attachStacktrace: false,
    ...(input.logs && sentryMajor(input.sdkVersion) < 11 ? { enableLogs: true } : {}),
  }
}

function sentryMajor(sdkVersion: string): number {
  const major = Number.parseInt(sdkVersion, 10)
  if (Number.isNaN(major))
    throw new TypeError(`Sentry SDK_VERSION "${sdkVersion}" does not start with a major version.`)
  return major
}

/**
 * The environment name for a report.
 *
 * `hostname` is the browser's. The server has none, so it always takes the
 * fallback, which a deploy sets through `SENTRY_ENVIRONMENT`. That is how the
 * two sites with a staging deployment already split the two halves.
 */
export function resolveEnvironment(policy: EnvironmentPolicy, hostname?: string): string {
  if (!hostname)
    return policy.fallback
  const match = policy.hostPrefixes.find(entry => hostname.startsWith(entry.prefix))
  return match ? match.name : policy.fallback
}

export function resolveTracesSampleRate(policy: SampleRatePolicy, environment: string): number {
  const rate = policy.byEnvironment[environment]
  return typeof rate === 'number' ? rate : policy.fallback
}

/**
 * Hosts that are never a deployment.
 *
 * `nuxt preview` and `wrangler dev` both run a production build with
 * `NODE_ENV=production`, and `import.meta.dev` is false in that bundle, so a
 * laptop used to report into the live project. One site measured 232 events
 * from a single local session against 223 real errors org wide in the same day.
 *
 * An unrecognised host still reports, so a real deployment can never be
 * silenced by this rule.
 */
const LOCAL_REPORTING_HOST = /^(?:localhost|\[?::1\]?|0\.0\.0\.0|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|[^.]+\.local(?:host)?)$/i

export function isLocalReportingHost(hostname: string): boolean {
  return LOCAL_REPORTING_HOST.test(hostname)
}

/**
 * The browser's view of the Report Target.
 *
 * The build time gate cannot see where the bundle is served from, so the last
 * gate runs here. A local host downgrades an enabled target to disabled rather
 * than throwing, so the reason stays readable in a dev tools log.
 */
export function resolveClientTarget(target: ReportTarget, hostname: string): ReportTarget {
  if (target._tag === 'disabled')
    return target
  return isLocalReportingHost(hostname) ? { _tag: 'disabled', reason: 'local-host' } : target
}

/** One line saying why this build sends nothing. Written for a developer, not a user. */
export function describeDisabledTarget(reason: ReportDisabledReason): string {
  switch (reason) {
    case 'option':
      return 'nuxtSentry.enabled is false.'
    case 'no-dsn':
      return 'No nuxtSentry.dsn is set.'
    case 'not-production':
      return 'This build is not a production build.'
    case 'no-release':
      return 'This build carries no release identity, so it was not produced by a deploy. Set SENTRY_RELEASE in the deploy workflow, or set gate to "always".'
    case 'not-ci':
      return 'This build was not produced in CI. Set gate to "release" or "always" to report from a local production build.'
    case 'local-host':
      return 'This build is served from a local host, so it is not a deployment.'
  }
}
