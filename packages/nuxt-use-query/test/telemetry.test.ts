import { describe, expect, it } from 'vitest'
import {
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
    expect(isFetchWaterfall(summary, {
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
    expect(isFetchWaterfall(summary, {
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
      request: 'GET /dashboard',
      server: true,
      threshold: 2,
      url: '/api/sites',
    })).toBe(`duplicate server fetch
  fetch  : GET /api/sites
  count  : 2 (threshold 2)
  request: GET /dashboard`)

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
    expect(output).toContain('reason       : tracked fetches ran one at a time')
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
