import type { SentryBuildInput } from '../src/build/sentry-build'
import { describe, expect, it } from 'vitest'
import { checkSentryBuild, hasSentryAuthToken, resolveSentryBuildOptions, uploadsSourceMaps } from '../src/build/sentry-build'

function input(overrides: Partial<SentryBuildInput> = {}): SentryBuildInput {
  return {
    org: 'harlan-zw',
    project: 'site',
    release: 'abc123',
    sourceMaps: true,
    authToken: 'token',
    hasAuthToken: true,
    ...overrides,
  }
}

describe('hasSentryAuthToken', () => {
  it('counts a local dotenv file as a token', () => {
    expect(hasSentryAuthToken({ hasDotenvFile: true })).toBe(true)
  })

  it('ignores a blank environment token', () => {
    expect(hasSentryAuthToken({ sentryAuthToken: '  ', hasDotenvFile: false })).toBe(false)
  })
})

describe('resolveSentryBuildOptions', () => {
  it('names the release a deploy carries', () => {
    expect(resolveSentryBuildOptions(input()).release).toEqual({ name: 'abc123' })
  })

  it('uploads source maps for a named release', () => {
    expect(resolveSentryBuildOptions(input()).sourcemaps.disable).toBe(false)
  })

  it('refuses to create a release when the build carries no identity', () => {
    expect(resolveSentryBuildOptions(input({ release: '' })).release).toEqual({
      create: false,
      inject: false,
    })
  })

  it('uploads no source map when the build carries no release', () => {
    expect(resolveSentryBuildOptions(input({ release: '' })).sourcemaps.disable).toBe(true)
  })

  it('uploads no source map without an auth token', () => {
    expect(resolveSentryBuildOptions(input({ hasAuthToken: false })).sourcemaps.disable).toBe(true)
  })
})

describe('uploadsSourceMaps', () => {
  it('needs a token and a release together', () => {
    expect(uploadsSourceMaps({ sourceMaps: true, hasAuthToken: true, release: 'abc123' })).toBe(true)
    expect(uploadsSourceMaps({ sourceMaps: true, hasAuthToken: true, release: '' })).toBe(false)
    expect(uploadsSourceMaps({ sourceMaps: true, hasAuthToken: false, release: 'abc123' })).toBe(false)
    expect(uploadsSourceMaps({ sourceMaps: false, hasAuthToken: true, release: 'abc123' })).toBe(false)
  })
})

describe('checkSentryBuild', () => {
  function check(overrides: Partial<Parameters<typeof checkSentryBuild>[0]> = {}) {
    return checkSentryBuild({
      sourceMaps: true,
      hasAuthToken: true,
      project: 'site',
      release: 'abc123',
      gate: 'release',
      isProduction: true,
      ...overrides,
    })
  }

  it('passes a deploy build', () => {
    expect(check()).toEqual([])
  })

  it('fails a source map upload with no project', () => {
    expect(check({ project: undefined })).toContainEqual(
      expect.objectContaining({ _tag: 'error' }),
    )
  })

  it('warns that a build with no release keeps its source maps local', () => {
    const messages = check({ release: '' }).map(issue => issue.message)
    expect(messages).toContainEqual(expect.stringContaining('Source maps stay local'))
  })
})
