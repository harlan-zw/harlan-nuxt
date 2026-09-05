/**
 * The Report Policy, for code this module does not register.
 *
 * Two callers need it. A queue Sentry client, which `@harlan-zw/nuxt-cf-jobs`
 * owns through `runWithQueueSentry`, must apply the same rules as the request
 * client or a background failure is filtered differently from a foreground one.
 * A non Cloudflare site keeps its own `sentry.server.config.ts` and builds its
 * `beforeSend` from here.
 *
 * This barrel stays SDK-free. `@sentry/cloudflare` is an optional peer, and a
 * Node preset does not install it, so a Cloudflare-only helper such as
 * `withSentryTask` lives in its own subpath export instead of here.
 */

export {
  decideReport,
  errorChain,
  errorStatusCode,
  isTransientError,
  matchesStatus,
  reportBreadcrumbMessages,
  reportFrameCount,
} from '../shared/drop'
export {
  applyReportPolicy,
  createBeforeSend,
  createClientNoiseOptions,
  createSentryDataCollection,
  describeDisabledTarget,
  isLocalReportingHost,
  resolveClientTarget,
  resolveEnvironment,
  resolveTracesSampleRate,
} from '../shared/policy'
export {
  isSecretKey,
  REDACTED,
  redactErrorReport,
  redactText,
  redactValue,
} from '../shared/redact'
export type { CaptureTaskFailure, ReportingTask, TaskFailureReport, TaskLike, TaskRunContext } from '../shared/task'
export { describeTaskFailure, resolveTaskName, withTaskReporting } from '../shared/task'
export type {
  DataCollection,
  DropRuleName,
  EnvironmentPolicy,
  ErrorReport,
  ErrorReportHint,
  MessagePattern,
  ReportDecision,
  ReportDisabledReason,
  ReportPolicy,
  ReportScope,
  ReportTarget,
  SampleRatePolicy,
  SentryRuntimeConfig,
  SerializedPattern,
  StatusRange,
  WideEventDrainPolicy,
  WideEventLogLevel,
} from '../shared/types'
export type { WorkerAttribution } from './attribution'
export { resolveWorkerAttribution } from './attribution'
export type {
  DrainedWideEvent,
  SentryCorrelation,
  WideEventLogDecision,
} from './wide-events'
export { decideWideEventLog, parseSentryCorrelation } from './wide-events'
