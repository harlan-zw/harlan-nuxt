import type { TargetInput } from '../src/build/target'
import { describe, expect, it } from 'vitest'
import {
  isCiBuild,
  resolveEnvironmentPolicy,
  resolveRelease,
  resolveReportTarget,
  resolveSampleRatePolicy,
} from '../src/build/target'
import { resolveEnvironment, resolveTracesSampleRate } from '../src/runtime/shared/policy'

function input(overrides: Partial<TargetInput> = {}): TargetInput {
  return {
    enabled: true,
    dsn: 'https://key@o1.ingest.us.sentry.io/2',
    gate: 'release',
    environment: 'production',
    tracesSampleRate: 0.05,
    logs: false,
    workerVersionBinding: 'CF_VERSION_METADATA',
    env: { nodeEnv: 'production', sentryRelease: 'abc123' },
    ...overrides,
  }
}

describe('isCiBuild', () => {
  it('accepts the spellings a runner uses', () => {
    expect(isCiBuild('true')).toBe(true)
    expect(isCiBuild('1')).toBe(true)
    expect(isCiBuild('yes')).toBe(true)
  })

  it('rejects an unset or explicitly falsy value', () => {
    expect(isCiBuild(undefined)).toBe(false)
    expect(isCiBuild('')).toBe(false)
    expect(isCiBuild('false')).toBe(false)
    expect(isCiBuild('0')).toBe(false)
  })
})

describe('resolveRelease', () => {
  it('prefers SENTRY_RELEASE over GITHUB_SHA', () => {
    expect(resolveRelease({ sentryRelease: 'deployed', githubSha: 'branch-tip' })).toBe('deployed')
  })

  it('falls back to GITHUB_SHA', () => {
    expect(resolveRelease({ githubSha: 'branch-tip' })).toBe('branch-tip')
  })

  it('falls back to VERCEL_GIT_COMMIT_SHA, so a Vercel build is not silenced', () => {
    expect(resolveRelease({ vercelGitCommitSha: 'vercel-sha' })).toBe('vercel-sha')
  })

  it('returns an empty string when none is set', () => {
    expect(resolveRelease({})).toBe('')
  })
})

describe('resolveReportTarget', () => {
  it('enables a production build that carries a release', () => {
    const target = resolveReportTarget(input())
    expect(target).toMatchObject({ _tag: 'enabled', release: 'abc123' })
  })

  it('disables a build that opted out', () => {
    expect(resolveReportTarget(input({ enabled: false }))).toEqual({ _tag: 'disabled', reason: 'option' })
  })

  it('disables a build with no DSN', () => {
    expect(resolveReportTarget(input({ dsn: '  ' }))).toEqual({ _tag: 'disabled', reason: 'no-dsn' })
  })

  it('disables a development build', () => {
    expect(resolveReportTarget(input({ env: { nodeEnv: 'development' } })))
      .toEqual({ _tag: 'disabled', reason: 'not-production' })
  })

  it('disables a production build with no release under the release gate', () => {
    expect(resolveReportTarget(input({ env: { nodeEnv: 'production' } })))
      .toEqual({ _tag: 'disabled', reason: 'no-release' })
  })

  it('enables a production build with no release under the always gate', () => {
    expect(resolveReportTarget(input({ gate: 'always', env: { nodeEnv: 'production' } })))
      .toMatchObject({ _tag: 'enabled', release: '' })
  })

  it('disables a local production build under the ci gate', () => {
    expect(resolveReportTarget(input({ gate: 'ci', env: { nodeEnv: 'production', sentryRelease: 'abc' } })))
      .toEqual({ _tag: 'disabled', reason: 'not-ci' })
  })

  it('enables a CI production build under the ci gate', () => {
    expect(resolveReportTarget(input({ gate: 'ci', env: { nodeEnv: 'production', sentryRelease: 'abc', ci: 'true' } })))
      .toMatchObject({ _tag: 'enabled' })
  })

  it('carries the app tag and the worker binding through', () => {
    expect(resolveReportTarget(input({ app: 'pro', workerVersionBinding: 'CF_VERSION_METADATA' })))
      .toMatchObject({ app: 'pro', workerVersionBinding: 'CF_VERSION_METADATA' })
  })

  it('turns a false worker binding into null', () => {
    expect(resolveReportTarget(input({ workerVersionBinding: false })))
      .toMatchObject({ workerVersionBinding: null })
  })
})

describe('resolveEnvironmentPolicy and resolveEnvironment', () => {
  it('names every deployment when the option is a string', () => {
    const policy = resolveEnvironmentPolicy('production', {})
    expect(resolveEnvironment(policy)).toBe('production')
    expect(resolveEnvironment(policy, 'staging.example.com')).toBe('production')
  })

  it('splits a staging host from production', () => {
    const policy = resolveEnvironmentPolicy({ 'staging.': 'staging' }, {})
    expect(resolveEnvironment(policy, 'staging.example.com')).toBe('staging')
    expect(resolveEnvironment(policy, 'example.com')).toBe('production')
  })

  it('gives the server the fallback, because it has no hostname', () => {
    const policy = resolveEnvironmentPolicy({ 'staging.': 'staging' }, {})
    expect(resolveEnvironment(policy)).toBe('production')
  })

  it('lets SENTRY_ENVIRONMENT name the server side deployment', () => {
    const policy = resolveEnvironmentPolicy({ 'staging.': 'staging' }, { sentryEnvironment: 'staging' })
    expect(resolveEnvironment(policy)).toBe('staging')
  })

  it('prefers the longest matching host prefix', () => {
    const policy = resolveEnvironmentPolicy({ 'staging.': 'staging', 'staging.api.': 'staging-api' }, {})
    expect(resolveEnvironment(policy, 'staging.api.example.com')).toBe('staging-api')
  })
})

describe('resolveSampleRatePolicy and resolveTracesSampleRate', () => {
  it('uses one rate everywhere when the option is a number', () => {
    const policy = resolveSampleRatePolicy(0.05)
    expect(resolveTracesSampleRate(policy, 'production')).toBe(0.05)
    expect(resolveTracesSampleRate(policy, 'staging')).toBe(0.05)
  })

  it('uses a rate per environment', () => {
    const policy = resolveSampleRatePolicy({ production: 0.05, staging: 1 })
    expect(resolveTracesSampleRate(policy, 'staging')).toBe(1)
    expect(resolveTracesSampleRate(policy, 'production')).toBe(0.05)
    expect(resolveTracesSampleRate(policy, 'preview')).toBe(0.05)
  })

  it('rejects a rate outside 0 to 1', () => {
    expect(() => resolveSampleRatePolicy(1.5)).toThrow(/between 0 and 1/)
    expect(() => resolveSampleRatePolicy({ staging: -1 })).toThrow(/staging/)
  })
})
