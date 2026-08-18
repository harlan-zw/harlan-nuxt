import { describe, expect, it } from 'vitest'
import {
  analyseFetchChain,
  collectFetchTelemetryOptionWarnings,
  createFetchTelemetryState,
  endFetchTelemetry,
  formatDuplicateFetchTelemetryEvent,
  formatFetchTelemetryEvent,
  formatFetchTimeoutTelemetryEvent,
  formatFetchWaterfallTelemetryEvent,
  formatLargePayloadTelemetryEvent,
  formatNestedFetchTelemetryEvent,
  formatQueryTelemetryFinishEvent,
  formatQueryTelemetryStartEvent,
  formatRecursiveFetchTelemetryEvent,
  formatSlowFetchTelemetryEvent,
  isFetchWaterfall,
  normalizeFetchTelemetryOptions,
  normalizeLargePayloadThreshold,
  normalizeSlowFetchThreshold,
  recordDuplicateFetch,
  recordFetchTelemetry,
  resolveLargePayloadThreshold,
  resolveSlowFetchThreshold,
  startFetchTelemetry,
  summarizeFetchTelemetry,
} from '../src/runtime/telemetry'

describe('fetch telemetry', () => {
  it('summarizes sequential fetches as a likely waterfall', () => {
    const state = createFetchTelemetryState()

    startFetchTelemetry(state, 0)
    endFetchTelemetry(state, 0, 1_500)
    recordFetchTelemetry(state, {
      durationMs: 1_500,
      endedAt: 1_500,
      method: 'GET',
      ok: true,
      startedAt: 0,
      url: '/api/a',
    })
    startFetchTelemetry(state, 1_500)
    endFetchTelemetry(state, 1_500, 3_200)
    recordFetchTelemetry(state, {
      durationMs: 1_700,
      endedAt: 3_200,
      method: 'GET',
      ok: true,
      startedAt: 1_500,
      url: '/api/b',
    })

    const summary = summarizeFetchTelemetry(state)!
    expect(summary).toMatchObject({
      fetches: 2,
      maxParallel: 1,
      slowestMs: 1_700,
      upstreamMs: 3_200,
      wallMs: 3_200,
    })
    expect(summary.timeline).toMatchObject([
      { durationMs: 1_500, offsetMs: 0, url: '/api/a' },
      { durationMs: 1_700, offsetMs: 1_500, url: '/api/b' },
    ])
    expect(isFetchWaterfall(summary, analyseFetchChain(summary.timeline), {
      waterfallMinChainBeyondSlowestMs: 1_000,
      waterfallMinChainDepth: 2,
      waterfallMinCriticalPathShare: 0.75,
      waterfallMinFetches: 2,
      waterfallThreshold: 3_000,
    })).toBe(true)
  })

  it('does not flag parallel fan-out as a waterfall', () => {
    const state = createFetchTelemetryState()

    startFetchTelemetry(state, 0)
    startFetchTelemetry(state, 10)
    endFetchTelemetry(state, 0, 1_500)
    endFetchTelemetry(state, 10, 1_510)

    const summary = summarizeFetchTelemetry(state)!
    expect(summary.maxParallel).toBe(2)
    expect(summary.upstreamMs).toBeGreaterThan(summary.wallMs)
    expect(isFetchWaterfall(summary, analyseFetchChain(summary.timeline), {
      waterfallMinChainBeyondSlowestMs: 1_000,
      waterfallMinChainDepth: 2,
      waterfallMinCriticalPathShare: 0.75,
      waterfallMinFetches: 2,
      waterfallThreshold: 1_000,
    })).toBe(false)
  })

  it('normalizes runtime options from string environment values', () => {
    expect(normalizeFetchTelemetryOptions({
      console: 'false' as any,
      debug: 'true' as any,
      duplicateFetchThreshold: '2' as any,
      enabled: 'false' as any,
      nestedFetchDepthThreshold: '3' as any,
      recursiveFetchWarning: 'false' as any,
      slowFetchThreshold: '1200' as any,
      timeout: '15000' as any,
      waterfallMinFetches: '3' as any,
      waterfallThreshold: '2500' as any,
    })).toMatchObject({
      console: false,
      debug: true,
      duplicateFetchThreshold: 2,
      enabled: false,
      nestedFetchDepthThreshold: 3,
      recursiveFetchWarning: false,
      slowFetchThreshold: 1_200,
      timeout: 15_000,
      waterfallMinFetches: 3,
      waterfallThreshold: 2_500,
    })
  })

  it('allows disabling the default server fetch timeout', () => {
    expect(normalizeFetchTelemetryOptions({ timeout: false }).timeout).toBe(false)
    expect(normalizeFetchTelemetryOptions({ timeout: '0' as any }).timeout).toBe(false)
  })

  it('normalizes a per-host slow-fetch threshold map', () => {
    const normalized = normalizeSlowFetchThreshold({
      default: '3000' as any,
      hosts: {
        'gscdump.com': '12000' as any,
        'WWW.Example.COM': 8_000,
        'muted.test': 0,
        'bad.test': 'nope' as any,
      },
    }, 3_000)
    expect(normalized).toEqual({
      default: 3_000,
      hosts: {
        'gscdump.com': 12_000,
        'example.com': 8_000,
        'muted.test': false,
      },
    })
  })

  it('falls back to the provided default for invalid thresholds', () => {
    expect(normalizeSlowFetchThreshold(undefined, 3_000)).toBe(3_000)
    expect(normalizeSlowFetchThreshold('nope' as any, 3_000)).toBe(3_000)
    expect(normalizeSlowFetchThreshold({ hosts: {} }, 3_000)).toEqual({ default: 3_000, hosts: {} })
    expect(normalizeSlowFetchThreshold(false, 3_000)).toBe(false)
  })

  it('resolves per-host thresholds with www-stripping and default fallthrough', () => {
    const map = normalizeSlowFetchThreshold({
      default: 3_000,
      hosts: { 'gscdump.com': 12_000, 'muted.test': 0 },
    }, 3_000)
    // exact host override
    expect(resolveSlowFetchThreshold(map, 'gscdump.com')).toBe(12_000)
    // www. prefix is stripped before lookup
    expect(resolveSlowFetchThreshold(map, 'www.gscdump.com')).toBe(12_000)
    // explicit mute
    expect(resolveSlowFetchThreshold(map, 'muted.test')).toBe(false)
    // un-mapped host + relative/internal (undefined) fall to default
    expect(resolveSlowFetchThreshold(map, 'other.example')).toBe(3_000)
    expect(resolveSlowFetchThreshold(map, undefined)).toBe(3_000)
    // a plain number applies to every host
    expect(resolveSlowFetchThreshold(5_000, 'gscdump.com')).toBe(5_000)
  })

  it('defaults large-payload detection to 300kb and normalizes byte thresholds', () => {
    // on by default at Sentry's 300kb; users tune or mute as needed
    expect(normalizeFetchTelemetryOptions().largePayloadThreshold).toBe(300_000)
    expect(normalizeFetchTelemetryOptions({ largePayloadThreshold: '500000' as any }).largePayloadThreshold).toBe(500_000)
    expect(normalizeFetchTelemetryOptions({ largePayloadThreshold: false }).largePayloadThreshold).toBe(false)
    expect(normalizeFetchTelemetryOptions({ largePayloadThreshold: 0 as any }).largePayloadThreshold).toBe(false)
  })

  it('normalizes and resolves a per-host large-payload threshold map', () => {
    const normalized = normalizeLargePayloadThreshold({
      default: '300000' as any,
      hosts: {
        'searchconsole.googleapis.com': 0,
        'WWW.Example.COM': 1_000_000,
        'bad.test': 'nope' as any,
      },
    }, false)
    expect(normalized).toEqual({
      default: 300_000,
      hosts: {
        'searchconsole.googleapis.com': false,
        'example.com': 1_000_000,
      },
    })
    // exact host mute (an upstream you don't control), www-stripping, default fallthrough
    expect(resolveLargePayloadThreshold(normalized, 'searchconsole.googleapis.com')).toBe(false)
    expect(resolveLargePayloadThreshold(normalized, 'www.example.com')).toBe(1_000_000)
    expect(resolveLargePayloadThreshold(normalized, 'other.example')).toBe(300_000)
    expect(resolveLargePayloadThreshold(normalized, undefined)).toBe(300_000)
    // false/number shorthands
    expect(resolveLargePayloadThreshold(false, 'example.com')).toBe(false)
    expect(resolveLargePayloadThreshold(500_000, 'example.com')).toBe(500_000)
    // invalid input falls back
    expect(normalizeLargePayloadThreshold('nope' as any, false)).toBe(false)
    expect(normalizeLargePayloadThreshold(undefined, 300_000)).toBe(300_000)
  })

  it('formats server fetch events as readable blocks', () => {
    expect(formatFetchTelemetryEvent({
      durationMs: 42,
      method: 'GET',
      ok: true,
      request: 'GET /',
      server: true,
      url: '/api/hello',
    })).toBe(`server fetch completed
  fetch   : GET /api/hello
  duration: 42ms
  request : GET /`)

    expect(formatSlowFetchTelemetryEvent({
      durationMs: 1_251,
      method: 'POST',
      ok: true,
      request: 'GET /account',
      server: true,
      thresholdMs: 1_000,
      url: '/api/user',
    })).toBe(`slow server fetch
  fetch   : POST /api/user
  duration: 1.25s (threshold 1.00s)
  request : GET /account`)

    expect(formatFetchTimeoutTelemetryEvent({
      durationMs: 20_003,
      method: 'GET',
      ok: false,
      request: 'GET /dashboard',
      server: true,
      timeoutMs: 20_000,
      url: '/api/slow',
    })).toBe(`server fetch timed out
  fetch   : GET /api/slow
  duration: 20.0s
  timeout : 20.0s
  request : GET /dashboard`)

    expect(formatLargePayloadTelemetryEvent({
      bytesLength: 2_621_440,
      durationMs: 180,
      method: 'POST',
      ok: true,
      request: 'GET /sync',
      server: true,
      thresholdBytes: 300_000,
      url: 'searchconsole.googleapis.com/v3/query',
    })).toBe(`large HTTP payload
  fetch  : POST searchconsole.googleapis.com/v3/query
  size   : 2.50 MB (threshold 293 KB)
  request: GET /sync`)
  })

  it('formats internal fetch warning events as readable blocks', () => {
    expect(formatDuplicateFetchTelemetryEvent({
      count: 2,
      method: 'GET',
      path: '/api/sites',
      request: 'GET /dashboard',
      server: true,
      threshold: 2,
      variants: ['?page=1', '?page=2'],
    })).toBe(`duplicate server fetch
  fetch   : GET /api/sites
  count   : 2 (threshold 2)
  variants: ?page=1, ?page=2
  request : GET /dashboard`)

    expect(formatNestedFetchTelemetryEvent({
      depth: 3,
      method: 'GET',
      request: 'GET /dashboard',
      server: true,
      stack: ['GET /dashboard', 'GET /api/a', 'GET /api/b'],
      threshold: 3,
      url: '/api/b',
    })).toBe(`nested server fetch
  fetch  : GET /api/b
  depth  : 3 (threshold 3)
  request: GET /dashboard
  stack:
    1. GET /dashboard
    2. GET /api/a
    3. GET /api/b`)

    expect(formatRecursiveFetchTelemetryEvent({
      depth: 3,
      method: 'GET',
      request: 'GET /api/a',
      server: true,
      stack: ['GET /api/a', 'GET /api/b', 'GET /api/a'],
      url: '/api/a',
    })).toBe(`recursive server fetch
  fetch  : GET /api/a
  depth  : 3
  request: GET /api/a
  stack:
    1. GET /api/a
    2. GET /api/b
    3. GET /api/a`)
  })

  it('formats waterfall events with a readable timeline', () => {
    const output = formatFetchWaterfallTelemetryEvent({
      chainDepth: 2,
      criticalPath: ['/api/a', '/api/b'],
      criticalPathMs: 310,
      fetches: 2,
      maxParallel: 1,
      minFetches: 2,
      parallelismRatio: 1,
      request: 'GET /dashboard',
      server: true,
      slowestMs: 180,
      thresholdMs: 200,
      timeline: [
        {
          durationMs: 180,
          endedAt: 180,
          method: 'GET',
          offsetMs: 0,
          ok: true,
          startedAt: 0,
          url: '/api/a',
        },
        {
          durationMs: 130,
          endedAt: 310,
          method: 'GET',
          offsetMs: 180,
          ok: true,
          startedAt: 180,
          url: '/api/b',
        },
      ],
      upstreamMs: 310,
      wallMs: 310,
    })

    expect(output).toContain('likely server fetch waterfall')
    expect(output).toContain('request      : GET /dashboard')
    expect(output).toContain('reason       : 2 serial levels cost 310ms of 310ms wall time')
    expect(output).toContain('critical path:')
    expect(output).toContain('upstream time: 310ms (1.00x wall)')
    expect(output).toContain('timeline (0ms -> 310ms):')
    expect(output).toContain('[###################-------------] GET /api/a')
    expect(output).toContain('[------------------##############] GET /api/b')
  })

  it('formats query telemetry events as readable one-line messages', () => {
    expect(formatQueryTelemetryStartEvent({
      client: false,
      key: 'hello',
      request: '/api/hello',
      server: true,
      startedAt: 1_000,
    })).toBe('query hello -> /api/hello started on server')

    expect(formatQueryTelemetryFinishEvent({
      client: true,
      durationMs: 24,
      endedAt: 1_024,
      key: 'hello',
      request: '/api/hello',
      server: false,
      startedAt: 1_000,
      status: 'success',
    })).toBe('query hello -> /api/hello succeeded in 24ms on client')
  })
})

describe('fetch telemetry option warnings', () => {
  it('reports a slow-fetch threshold that the timeout can never reach', () => {
    const warnings = collectFetchTelemetryOptionWarnings(normalizeFetchTelemetryOptions({
      slowFetchThreshold: 30_000,
      timeout: 20_000,
    }))

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      _tag: 'slow-fetch-threshold-above-timeout',
      thresholdMs: 30_000,
      timeoutMs: 20_000,
    })
    expect(warnings[0]?.message).toContain('below the timeout')
  })

  it('reports each host threshold that the timeout can never reach', () => {
    const warnings = collectFetchTelemetryOptionWarnings(normalizeFetchTelemetryOptions({
      slowFetchThreshold: {
        default: 3_000,
        hosts: { 'gscdump.com': 30_000, 'ok.com': 5_000 },
      },
      timeout: 20_000,
    }))

    expect(warnings.map(warning => warning.host)).toEqual(['gscdump.com'])
  })

  it('stays silent when every threshold sits below the timeout', () => {
    const warnings = collectFetchTelemetryOptionWarnings(normalizeFetchTelemetryOptions({
      slowFetchThreshold: { default: 3_000, hosts: { 'gscdump.com': 15_000 } },
      timeout: 20_000,
    }))

    expect(warnings).toEqual([])
  })

  it('stays silent when the timeout is disabled', () => {
    const warnings = collectFetchTelemetryOptionWarnings(normalizeFetchTelemetryOptions({
      slowFetchThreshold: 30_000,
      timeout: false,
    }))

    expect(warnings).toEqual([])
  })
})

describe('fetch chain analysis', () => {
  function timelineOf(entries: Array<[url: string, startedAt: number, endedAt: number]>) {
    const state = createFetchTelemetryState()
    for (const [, startedAt] of entries)
      startFetchTelemetry(state, startedAt)
    for (const [url, startedAt, endedAt] of entries) {
      endFetchTelemetry(state, startedAt, endedAt)
      recordFetchTelemetry(state, {
        durationMs: endedAt - startedAt,
        endedAt,
        method: 'GET',
        ok: true,
        startedAt,
        url,
      })
    }
    return summarizeFetchTelemetry(state)!
  }

  const waterfallOptions = {
    waterfallMinChainBeyondSlowestMs: 1_000,
    waterfallMinChainDepth: 2,
    waterfallMinCriticalPathShare: 0.75,
    waterfallMinFetches: 2,
    waterfallThreshold: 3_000,
  }

  it('measures the longest dependency chain, not the parallelism ratio', () => {
    const summary = timelineOf([
      ['/api/a1', 0, 2_000],
      ['/api/a2', 0, 1_900],
      ['/api/a3', 0, 1_800],
      ['/api/b1', 2_000, 4_000],
      ['/api/b2', 2_000, 3_900],
      ['/api/c1', 4_000, 6_000],
    ])

    const analysis = analyseFetchChain(summary.timeline)

    expect(analysis).toMatchObject({
      chainDepth: 3,
      criticalPathMs: 6_000,
      slowestMs: 2_000,
      wallMs: 6_000,
    })
    expect(analysis.criticalPath).toEqual(['/api/a1', '/api/b1', '/api/c1'])
    expect(isFetchWaterfall(summary, analysis, waterfallOptions)).toBe(true)
  })

  it('leaves one slow upstream with parallel siblings alone', () => {
    const summary = timelineOf([
      ['/api/slow', 0, 10_000],
      ['/api/fast', 0, 500],
    ])

    const analysis = analyseFetchChain(summary.timeline)

    expect(analysis.chainDepth).toBe(1)
    expect(isFetchWaterfall(summary, analysis, waterfallOptions)).toBe(false)
  })

  it('leaves a short chain of cheap follow-ups alone', () => {
    const summary = timelineOf([
      ['/api/slow', 0, 3_500],
      ['/api/cheap', 3_500, 3_600],
    ])

    const analysis = analyseFetchChain(summary.timeline)

    expect(analysis.chainDepth).toBe(2)
    expect(isFetchWaterfall(summary, analysis, waterfallOptions)).toBe(false)
  })
})

describe('duplicate fetch grouping', () => {
  it('groups repeats of one path across differing query strings', () => {
    const state = createFetchTelemetryState()

    recordDuplicateFetch(state, 'GET', '/api/pro/audit/pages', '?slice=a')
    const group = recordDuplicateFetch(state, 'GET', '/api/pro/audit/pages', '?slice=b')

    expect(group).toMatchObject({
      count: 2,
      method: 'GET',
      path: '/api/pro/audit/pages',
    })
    expect(group.variants).toEqual(['?slice=a', '?slice=b'])
  })

  it('keeps different paths apart', () => {
    const state = createFetchTelemetryState()

    recordDuplicateFetch(state, 'GET', '/api/a', '')
    const group = recordDuplicateFetch(state, 'GET', '/api/b', '')

    expect(group.count).toBe(1)
  })
})
