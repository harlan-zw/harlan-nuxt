import { describe, expect, it } from 'vitest'
import {
  createFetchTelemetryState,
  endFetchTelemetry,
  formatFetchTelemetryEvent,
  formatFetchWaterfallTelemetryEvent,
  formatQueryTelemetryFinishEvent,
  formatQueryTelemetryStartEvent,
  formatSlowFetchTelemetryEvent,
  isFetchWaterfall,
  normalizeFetchTelemetryOptions,
  startFetchTelemetry,
  summarizeFetchTelemetry,
} from '../src/runtime/telemetry'

describe('fetch telemetry', () => {
  it('summarizes sequential fetches as a likely waterfall', () => {
    const state = createFetchTelemetryState()

    startFetchTelemetry(state, 0)
    endFetchTelemetry(state, 0, 1_500)
    startFetchTelemetry(state, 1_500)
    endFetchTelemetry(state, 1_500, 3_200)

    const summary = summarizeFetchTelemetry(state)!
    expect(summary).toMatchObject({
      fetches: 2,
      maxParallel: 1,
      slowestMs: 1_700,
      upstreamMs: 3_200,
      wallMs: 3_200,
    })
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
      debug: 'true' as any,
      enabled: 'false' as any,
      slowFetchThreshold: '1200' as any,
      waterfallMinFetches: '3' as any,
      waterfallThreshold: '2500' as any,
    })).toMatchObject({
      debug: true,
      enabled: false,
      slowFetchThreshold: 1_200,
      waterfallMinFetches: 3,
      waterfallThreshold: 2_500,
    })
  })

  it('formats server fetch events as readable one-line messages', () => {
    expect(formatFetchTelemetryEvent({
      durationMs: 42,
      method: 'GET',
      ok: true,
      request: 'GET /',
      server: true,
      url: '/api/hello',
    })).toBe('fetch GET /api/hello completed in 42ms during GET /')

    expect(formatSlowFetchTelemetryEvent({
      durationMs: 1_251,
      method: 'POST',
      ok: true,
      request: 'GET /account',
      server: true,
      thresholdMs: 1_000,
      url: '/api/user',
    })).toBe('slow fetch POST /api/user took 1.25s threshold 1.00s during GET /account')
  })

  it('formats waterfall events as readable one-line messages', () => {
    expect(formatFetchWaterfallTelemetryEvent({
      fetches: 2,
      maxParallel: 1,
      minFetches: 2,
      parallelismRatio: 1,
      request: 'GET /dashboard',
      server: true,
      slowestMs: 180,
      thresholdMs: 200,
      upstreamMs: 310,
      wallMs: 310,
    })).toBe('fetch waterfall GET /dashboard: 2 fetches 310ms wall 310ms upstream 180ms slowest max parallel 1 threshold 200ms')
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
