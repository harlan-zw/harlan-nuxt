import { describe, expect, it } from 'vitest'
import {
  parseMessagePatterns,
  parseStatusRanges,
  resolveReportPolicy,
  serializePattern,
} from '../src/build/policy'
import {
  checkSentryBuild,
  hasSentryAuthToken,
  resolveSentryBuildOptions,
} from '../src/build/sentry-build'
import { resolveWorkerAttribution } from '../src/runtime/server/attribution'
import { decideWideEventLog, parseSentryCorrelation } from '../src/runtime/server/wide-events'
import {
  applyReportPolicy,
  createBeforeSend,
  createClientNoiseOptions,
  createSentryDataCollection,
  describeDisabledTarget,
  isLocalReportingHost,
  resolveClientTarget,
} from '../src/runtime/shared/policy'
import { REDACTED } from '../src/runtime/shared/redact'

describe('parseStatusRanges', () => {
  it('turns a single status into a one wide range', () => {
    expect(parseStatusRanges([404])).toEqual([{ from: 404, to: 404 }])
  })

  it('keeps an inclusive pair', () => {
    expect(parseStatusRanges([[400, 499]])).toEqual([{ from: 400, to: 499 }])
  })

  it('rejects a value that is not an HTTP status', () => {
    expect(() => parseStatusRanges([42])).toThrow(/HTTP status/)
    expect(() => parseStatusRanges([[499, 400]])).toThrow(/low to high/)
  })
})

describe('serializePattern', () => {
  it('drops the global flag, which would carry lastIndex between reports', () => {
    expect(serializePattern(/token=\w+/gi)).toEqual({ _tag: 'pattern', source: 'token=\\w+', flags: 'i' })
  })
})

describe('parseMessagePatterns', () => {
  it('keeps a string as a literal and a regexp as a pattern', () => {
    expect(parseMessagePatterns(['AbortError', /ResizeObserver/i])).toEqual([
      { _tag: 'literal', value: 'AbortError' },
      { _tag: 'pattern', source: 'ResizeObserver', flags: 'i' },
    ])
  })
})

describe('resolveReportPolicy', () => {
  it('gives the server 404 only, so an auth or rate limit spike stays visible', () => {
    expect(resolveReportPolicy({ scope: 'server', dataCollection: 'scrubbed', options: {} }).dropStatus)
      .toEqual([{ from: 404, to: 404 }])
  })

  it('gives the client 401, 403 and 404', () => {
    expect(resolveReportPolicy({ scope: 'client', dataCollection: 'scrubbed', options: {} }).dropStatus)
      .toEqual([{ from: 401, to: 401 }, { from: 403, to: 403 }, { from: 404, to: 404 }])
  })

  it('ships the browser noise lists by default', () => {
    const policy = resolveReportPolicy({ scope: 'client', dataCollection: 'scrubbed', options: {} })
    expect(policy.ignoreErrors.length).toBeGreaterThan(10)
    expect(policy.denyUrls.length).toBeGreaterThan(5)
  })
})

describe('createClientNoiseOptions', () => {
  it('rebuilds every serialised pattern into a live matcher', () => {
    const policy = resolveReportPolicy({
      scope: 'client',
      dataCollection: 'scrubbed',
      options: { browserNoise: false, ignoreErrors: ['AbortError', /boom/i], denyUrls: [/^iabjs:\/\//i] },
    })
    const noise = createClientNoiseOptions(policy)
    expect(noise.ignoreErrors[0]).toBe('AbortError')
    expect((noise.ignoreErrors[1] as RegExp).test('BOOM')).toBe(true)
    expect(noise.denyUrls[0]!.test('iabjs://x')).toBe(true)
  })
})

describe('applyReportPolicy', () => {
  const policy = resolveReportPolicy({ scope: 'server', dataCollection: 'scrubbed', options: {} })

  it('returns null for a dropped report', () => {
    expect(applyReportPolicy({ message: 'gone' }, { originalException: { statusCode: 404 } }, policy)).toBeNull()
  })

  it('returns a redacted report for a kept one', () => {
    const out = applyReportPolicy({ message: 'failed ?api_key=abcdef123456' }, undefined, policy)
    expect(out?.message).toBe(`failed ?api_key=${REDACTED}`)
  })

  it('redacts under dataCollection none too, because ofetch quotes the URL into the message', () => {
    const none = resolveReportPolicy({ scope: 'server', dataCollection: 'none', options: {} })
    const out = applyReportPolicy({ message: 'GET https://x.test?token=abcdef123456' }, undefined, none)
    expect(out?.message).toBe(`GET https://x.test?token=${REDACTED}`)
  })

  it('is the same decision through createBeforeSend', () => {
    const beforeSend = createBeforeSend(policy)
    expect(beforeSend({ message: 'gone' }, { originalException: { statusCode: 404 } })).toBeNull()
    expect(beforeSend({ message: 'boom' })).toEqual({ message: 'boom' })
  })
})

describe('createSentryDataCollection', () => {
  it('turns off every personal field the SDK collects by default', () => {
    expect(createSentryDataCollection()).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
    })
  })
})

describe('isLocalReportingHost and resolveClientTarget', () => {
  it('recognises every host a local production build is served from', () => {
    for (const host of ['localhost', '127.0.0.1', '0.0.0.0', '::1', '192.168.1.10', '10.0.0.4', '172.16.3.9', 'mac.local'])
      expect(isLocalReportingHost(host)).toBe(true)
  })

  it('lets a real deployment through', () => {
    for (const host of ['harlanzw.com', 'staging.nuxtseo.com', 'unhead.unjs.io'])
      expect(isLocalReportingHost(host)).toBe(false)
  })

  it('downgrades an enabled target served from a local host', () => {
    const enabled = {
      _tag: 'enabled' as const,
      dsn: 'x',
      release: 'r',
      environment: { fallback: 'production', hostPrefixes: [] },
      tracesSampleRate: { fallback: 0.05, byEnvironment: {} },
      app: null,
      logs: false,
      workerVersionBinding: null,
    }
    expect(resolveClientTarget(enabled, 'localhost')).toEqual({ _tag: 'disabled', reason: 'local-host' })
    expect(resolveClientTarget(enabled, 'harlanzw.com')).toBe(enabled)
  })
})

describe('describeDisabledTarget', () => {
  it('names the gate that failed and how to pass it', () => {
    expect(describeDisabledTarget('no-release')).toContain('SENTRY_RELEASE')
    expect(describeDisabledTarget('local-host')).toContain('local host')
  })
})

describe('hasSentryAuthToken', () => {
  it('accepts an environment token or a local dotenv file', () => {
    expect(hasSentryAuthToken({ sentryAuthToken: 'tok', hasDotenvFile: false })).toBe(true)
    expect(hasSentryAuthToken({ hasDotenvFile: true })).toBe(true)
    expect(hasSentryAuthToken({ sentryAuthToken: '  ', hasDotenvFile: false })).toBe(false)
  })
})

describe('resolveSentryBuildOptions', () => {
  it('disables the upload when no auth token is present', () => {
    const options = resolveSentryBuildOptions({ org: 'harlan-zw', project: 'zhead', release: 'r', sourceMaps: true, hasAuthToken: false })
    expect(options.sourcemaps.disable).toBe(true)
  })

  it('names the release so an uploaded map binds to its reports', () => {
    const options = resolveSentryBuildOptions({ org: 'harlan-zw', project: 'zhead', release: 'abc', sourceMaps: true, hasAuthToken: true })
    expect(options).toMatchObject({
      release: { name: 'abc' },
      telemetry: false,
      sourcemaps: { disable: false, filesToDeleteAfterUpload: ['**/*.map'] },
    })
  })
})

describe('checkSentryBuild', () => {
  const base = { sourceMaps: true, hasAuthToken: true, release: 'abc', gate: 'release' as const, isProduction: true }

  it('fails a build that would upload maps to an unnamed project', () => {
    expect(checkSentryBuild({ ...base, project: undefined })).toEqual([
      { _tag: 'error', message: expect.stringContaining('nuxtSentry.project') },
    ])
  })

  it('warns when maps upload with no release name', () => {
    expect(checkSentryBuild({ ...base, project: 'zhead', release: '' })).toEqual([
      { _tag: 'warning', message: expect.stringContaining('release name') },
      { _tag: 'warning', message: expect.stringContaining('no release identity') },
    ])
  })

  it('says nothing when the build is complete', () => {
    expect(checkSentryBuild({ ...base, project: 'zhead' })).toEqual([])
  })
})

describe('resolveWorkerAttribution', () => {
  it('reads the binding into tags and context', () => {
    expect(resolveWorkerAttribution({ id: 'v1', tag: 'blue', timestamp: '2026-08-18T00:00:00Z' })).toEqual({
      tags: { worker_version: 'v1', worker_version_tag: 'blue' },
      context: { id: 'v1', tag: 'blue', uploaded_at: '2026-08-18T00:00:00Z' },
    })
  })

  it('omits the tag when the deployment has none', () => {
    expect(resolveWorkerAttribution({ id: 'v1', timestamp: 't' })?.tags).toEqual({ worker_version: 'v1' })
  })

  it('returns null when the binding is absent or malformed', () => {
    expect(resolveWorkerAttribution(undefined)).toBeNull()
    expect(resolveWorkerAttribution({})).toBeNull()
    expect(resolveWorkerAttribution('CF_VERSION_METADATA')).toBeNull()
  })
})

describe('decideWideEventLog', () => {
  it('forwards a failing record as a log', () => {
    expect(decideWideEventLog({ 'level': 'error', 'name': 'http.request', 'http.status': 500 })).toEqual({
      _tag: 'log',
      level: 'error',
      message: 'http.request',
      attributes: { 'http.status': 500 },
    })
  })

  it('skips a successful record, so the log quota is spent on failures', () => {
    expect(decideWideEventLog({ level: 'info', name: 'http.request' })).toEqual({ _tag: 'skip' })
  })

  it('drops a non primitive attribute the log transport cannot carry', () => {
    const decision = decideWideEventLog({ level: 'warn', name: 'x', nested: { a: 1 }, ok: true })
    expect(decision).toEqual({ _tag: 'log', level: 'warn', message: 'x', attributes: { ok: true } })
  })
})

describe('parseSentryCorrelation', () => {
  it('reads the trace and span from the sentry-trace header', () => {
    expect(parseSentryCorrelation({ 'sentry-trace': 'aaaabbbbccccdddd-1111222233334444-1' })).toEqual({
      'sentry.traceId': 'aaaabbbbccccdddd',
      'sentry.spanId': '1111222233334444',
    })
  })

  it('returns nulls when no trace is active', () => {
    expect(parseSentryCorrelation(undefined)).toEqual({ 'sentry.traceId': null, 'sentry.spanId': null })
    expect(parseSentryCorrelation({})).toEqual({ 'sentry.traceId': null, 'sentry.spanId': null })
  })
})
