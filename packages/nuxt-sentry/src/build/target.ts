import type {
  EnvironmentPolicy,
  ReportTarget,
  SampleRatePolicy,
} from '../runtime/shared/types'

/**
 * Build time resolution of the Report Target.
 *
 * Every input arrives as an argument. Nothing here reads `process.env`, so the
 * whole gate is one pure function a test can drive.
 */

/** Who may send an Error Report. */
export type ReportGate = 'release' | 'ci' | 'always'

export interface BuildEnv {
  nodeEnv?: string
  sentryRelease?: string
  githubSha?: string
  vercelGitCommitSha?: string
  sentryEnvironment?: string
  ci?: string
}

export interface TargetInput {
  enabled: boolean
  dsn: string
  gate: ReportGate
  environment: string | Record<string, string>
  tracesSampleRate: number | Record<string, number>
  app?: string
  logs: boolean
  workerVersionBinding: string | false
  env: BuildEnv
}

/**
 * GitHub Actions sets `CI=true`, other runners use `1` or `yes`.
 *
 * Only an explicit falsy spelling counts as "not CI", so a runner that exports
 * an empty `CI` does not silently disable reporting.
 */
export function isCiBuild(ci: string | undefined): boolean {
  if (!ci)
    return false
  const normalized = ci.trim().toLowerCase()
  return normalized !== '' && normalized !== 'false' && normalized !== '0'
}

/**
 * The release identity this build carries.
 *
 * `GITHUB_SHA` is a fallback, not the answer. On a `workflow_run` event it is
 * the default branch tip rather than the commit that was built, so a deploy
 * workflow must export `SENTRY_RELEASE` from `github.event.workflow_run.head_sha`.
 *
 * `VERCEL_GIT_COMMIT_SHA` covers a site built by Vercel rather than by a GitHub
 * runner. Without it a Vercel deploy carries no release and the default gate
 * silences the whole site.
 */
export function resolveRelease(env: BuildEnv): string {
  return (env.sentryRelease || env.githubSha || env.vercelGitCommitSha || '').trim()
}

/**
 * Parse the environment option into a policy both scopes can read.
 *
 * A string names every deployment. A record maps a host prefix to a name, which
 * is how a staging deployment is split from production without a second Sentry
 * project. The server has no hostname, so `SENTRY_ENVIRONMENT` names it there.
 */
export function resolveEnvironmentPolicy(
  environment: string | Record<string, string>,
  env: BuildEnv,
): EnvironmentPolicy {
  const override = env.sentryEnvironment?.trim()
  if (typeof environment === 'string')
    return { fallback: override || environment, hostPrefixes: [] }

  const hostPrefixes = Object.entries(environment)
    .map(([prefix, name]) => ({ prefix, name }))
    // Longest prefix first, so `staging.api.` wins over `staging.`.
    .toSorted((a, b) => b.prefix.length - a.prefix.length)
  return { fallback: override || 'production', hostPrefixes }
}

export function resolveSampleRatePolicy(rate: number | Record<string, number>): SampleRatePolicy {
  if (typeof rate === 'number') {
    if (!Number.isFinite(rate) || rate < 0 || rate > 1)
      throw new TypeError('nuxtSentry.tracesSampleRate must be between 0 and 1')
    return { fallback: rate, byEnvironment: {} }
  }
  for (const [name, value] of Object.entries(rate)) {
    if (!Number.isFinite(value) || value < 0 || value > 1)
      throw new TypeError(`nuxtSentry.tracesSampleRate.${name} must be between 0 and 1`)
  }
  return { fallback: rate.production ?? 0, byEnvironment: { ...rate } }
}

/**
 * Whether this build may report, and under what identity.
 *
 * The gates run in a fixed order, and the first failure names itself. Ordering
 * `option` and `no-dsn` before the build shape keeps a deliberate opt out from
 * being reported as a broken deploy.
 */
export function resolveReportTarget(input: TargetInput): ReportTarget {
  if (!input.enabled)
    return { _tag: 'disabled', reason: 'option' }

  const dsn = input.dsn.trim()
  if (!dsn)
    return { _tag: 'disabled', reason: 'no-dsn' }

  if (input.env.nodeEnv !== 'production')
    return { _tag: 'disabled', reason: 'not-production' }

  const release = resolveRelease(input.env)
  if (input.gate === 'release' && !release)
    return { _tag: 'disabled', reason: 'no-release' }
  if (input.gate === 'ci' && !isCiBuild(input.env.ci))
    return { _tag: 'disabled', reason: 'not-ci' }

  return {
    _tag: 'enabled',
    dsn,
    release,
    environment: resolveEnvironmentPolicy(input.environment, input.env),
    tracesSampleRate: resolveSampleRatePolicy(input.tracesSampleRate),
    app: input.app?.trim() || null,
    logs: input.logs,
    workerVersionBinding: input.workerVersionBinding === false ? null : input.workerVersionBinding,
  }
}
