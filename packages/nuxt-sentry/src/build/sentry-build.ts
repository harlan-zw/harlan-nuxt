/**
 * The `sentry` build option block handed to `@sentry/nuxt/module`.
 *
 * That module owns the build plugin, the source map upload and the client entry
 * injection. This module only decides what it is configured with, so the nine
 * sites stop holding nine copies of the same block.
 */

export interface SourceMapEnv {
  sentryAuthToken?: string
  /** True when a local `.env.sentry-build-plugin` exists. */
  hasDotenvFile: boolean
}

/**
 * Whether a build can upload a source map.
 *
 * A local dotenv file counts. Two sites test `process.env.SENTRY_AUTH_TOKEN`
 * alone, so a local upload with a dotenv file silently did nothing.
 */
export function hasSentryAuthToken(env: SourceMapEnv): boolean {
  return Boolean(env.sentryAuthToken?.trim()) || env.hasDotenvFile
}

export interface SentryBuildInput {
  org: string
  project?: string
  release: string
  sourceMaps: boolean
  authToken?: string
  hasAuthToken: boolean
}

/**
 * What the build plugin may do about a release.
 *
 * The plugin names a release from git HEAD when the config omits one, and
 * creates it. A local build holding a token therefore published a release for
 * a commit that never deployed. Only a named release is ever created.
 */
export type SentryReleaseOptions
  = | { name: string }
    | { create: false, inject: false }

export interface SentryBuildOptions {
  org: string
  project?: string
  authToken?: string
  release: SentryReleaseOptions
  sourcemaps: {
    disable: boolean
    filesToDeleteAfterUpload: string[]
  }
  bundleSizeOptimizations: {
    excludeReplayShadowDom: boolean
    excludeReplayIframe: boolean
    excludeReplayWorker: boolean
  }
  telemetry: false
}

/**
 * Whether this build both may upload a source map and has a release to bind it to.
 *
 * The module reads the same answer to decide whether to emit a client map at
 * all, so the rule lives here once.
 */
export function uploadsSourceMaps(input: Pick<SentryBuildInput, 'sourceMaps' | 'hasAuthToken' | 'release'>): boolean {
  return input.sourceMaps && input.hasAuthToken && Boolean(input.release)
}

export function resolveSentryBuildOptions(input: SentryBuildInput): SentryBuildOptions {
  return {
    org: input.org,
    ...(input.project ? { project: input.project } : {}),
    ...(input.authToken ? { authToken: input.authToken } : {}),
    release: input.release ? { name: input.release } : { create: false, inject: false },
    sourcemaps: {
      // An unnamed release cannot bind an uploaded map to the reports it
      // explains, so the upload is waste that also invents the release.
      disable: !uploadsSourceMaps(input),
      filesToDeleteAfterUpload: ['**/*.map'],
    },
    // Session Replay is not used anywhere in the estate, and its code is the
    // largest single part of the browser bundle.
    bundleSizeOptimizations: {
      excludeReplayShadowDom: true,
      excludeReplayIframe: true,
      excludeReplayWorker: true,
    },
    telemetry: false,
  }
}

/** A build time finding that must reach the developer before the build ships. */
export type BuildIssue
  = | { _tag: 'error', message: string }
    | { _tag: 'warning', message: string }

export interface BuildCheckInput {
  sourceMaps: boolean
  hasAuthToken: boolean
  project?: string
  release: string
  gate: 'release' | 'ci' | 'always'
  isProduction: boolean
}

/**
 * Findings a build must surface.
 *
 * A missing project with an auth token present is an error: the upload would
 * succeed against whichever project the token happens to reach, which is the
 * exact failure one site wrote a preflight script to catch.
 */
export function checkSentryBuild(input: BuildCheckInput): BuildIssue[] {
  const issues: BuildIssue[] = []
  if (input.sourceMaps && input.hasAuthToken && !input.project) {
    issues.push({
      _tag: 'error',
      message: 'A Sentry auth token is present and source map upload is on, but nuxtSentry.project is not set. Set the project slug, or set sourceMaps to false.',
    })
  }
  if (input.sourceMaps && input.hasAuthToken && !input.release) {
    issues.push({
      _tag: 'warning',
      message: 'This build carries no release name. Source maps stay local, and no release is created. Set SENTRY_RELEASE in the deploy workflow.',
    })
  }
  if (input.isProduction && input.gate === 'release' && !input.release) {
    issues.push({
      _tag: 'warning',
      message: 'This production build carries no release identity, so it sends no Error Report. Set SENTRY_RELEASE in the deploy workflow, or set nuxtSentry.gate to "always".',
    })
  }
  return issues
}
