export interface FetchTelemetryRuntimeOptions {
  debug: boolean
  enabled: boolean
  slowFetchThreshold: number
  waterfallMinFetches: number
  waterfallThreshold: number
}

export interface FetchTelemetryState {
  active: number
  fetches: number
  firstStartedAt: number | undefined
  lastEndedAt: number | undefined
  maxParallel: number
  request: string | undefined
  slowestMs: number
  totalMs: number
}

export interface FetchTelemetrySummary {
  fetches: number
  maxParallel: number
  parallelismRatio: number
  slowestMs: number
  upstreamMs: number
  wallMs: number
}

export interface FetchTelemetryEvent {
  durationMs: number
  method: string
  ok: boolean
  request?: string
  server: true
  url: string
}

export interface SlowFetchTelemetryEvent extends FetchTelemetryEvent {
  thresholdMs: number
}

export interface FetchSummaryTelemetryEvent extends FetchTelemetrySummary {
  request: string
  server: true
}

export interface FetchWaterfallTelemetryEvent extends FetchSummaryTelemetryEvent {
  minFetches: number
  thresholdMs: number
}

export interface QueryTelemetryStartEvent {
  client: boolean
  key: string
  request: string
  server: boolean
  startedAt: number
}

export interface QueryTelemetryFinishEvent extends QueryTelemetryStartEvent {
  durationMs: number
  endedAt: number
  error?: unknown
  status: 'error' | 'success'
}

type TelemetryHookResult = Promise<void> | void

declare module 'nuxt/app' {
  interface RuntimeNuxtHooks {
    'nuxt-use-query:telemetry:query:start': (event: QueryTelemetryStartEvent) => TelemetryHookResult
    'nuxt-use-query:telemetry:query:finish': (event: QueryTelemetryFinishEvent) => TelemetryHookResult
  }
}

declare module 'nitropack/types' {
  interface NitroRuntimeHooks {
    'nuxt-use-query:telemetry:fetch': (event: FetchTelemetryEvent) => TelemetryHookResult
    'nuxt-use-query:telemetry:fetch:slow': (event: SlowFetchTelemetryEvent) => TelemetryHookResult
    'nuxt-use-query:telemetry:fetch:summary': (event: FetchSummaryTelemetryEvent) => TelemetryHookResult
    'nuxt-use-query:telemetry:fetch:waterfall': (event: FetchWaterfallTelemetryEvent) => TelemetryHookResult
  }
}

export const DEFAULT_FETCH_TELEMETRY_OPTIONS: FetchTelemetryRuntimeOptions = {
  debug: false,
  enabled: true,
  slowFetchThreshold: 3_000,
  waterfallMinFetches: 2,
  waterfallThreshold: 3_000,
}

export const NUXT_USE_QUERY_TELEMETRY_HOOKS = {
  fetch: 'nuxt-use-query:telemetry:fetch',
  fetchSlow: 'nuxt-use-query:telemetry:fetch:slow',
  fetchSummary: 'nuxt-use-query:telemetry:fetch:summary',
  fetchWaterfall: 'nuxt-use-query:telemetry:fetch:waterfall',
  queryFinish: 'nuxt-use-query:telemetry:query:finish',
  queryStart: 'nuxt-use-query:telemetry:query:start',
} as const

const MOSTLY_SEQUENTIAL_RATIO = 1.25

export function createFetchTelemetryState(): FetchTelemetryState {
  return {
    active: 0,
    fetches: 0,
    firstStartedAt: undefined,
    lastEndedAt: undefined,
    maxParallel: 0,
    request: undefined,
    slowestMs: 0,
    totalMs: 0,
  }
}

export function normalizeFetchTelemetryOptions(input: Partial<FetchTelemetryRuntimeOptions> = {}): FetchTelemetryRuntimeOptions {
  return {
    debug: booleanOption(input.debug, DEFAULT_FETCH_TELEMETRY_OPTIONS.debug),
    enabled: booleanOption(input.enabled, DEFAULT_FETCH_TELEMETRY_OPTIONS.enabled),
    slowFetchThreshold: numberOption(input.slowFetchThreshold, DEFAULT_FETCH_TELEMETRY_OPTIONS.slowFetchThreshold),
    waterfallMinFetches: numberOption(input.waterfallMinFetches, DEFAULT_FETCH_TELEMETRY_OPTIONS.waterfallMinFetches),
    waterfallThreshold: numberOption(input.waterfallThreshold, DEFAULT_FETCH_TELEMETRY_OPTIONS.waterfallThreshold),
  }
}

export function startFetchTelemetry(state: FetchTelemetryState, startedAt: number): void {
  state.active++
  state.maxParallel = Math.max(state.maxParallel, state.active)
  state.firstStartedAt = state.firstStartedAt == null
    ? startedAt
    : Math.min(state.firstStartedAt, startedAt)
}

export function endFetchTelemetry(state: FetchTelemetryState, startedAt: number, endedAt: number): number {
  const durationMs = Math.max(0, endedAt - startedAt)
  state.active = Math.max(0, state.active - 1)
  state.fetches++
  state.lastEndedAt = state.lastEndedAt == null
    ? endedAt
    : Math.max(state.lastEndedAt, endedAt)
  state.slowestMs = Math.max(state.slowestMs, durationMs)
  state.totalMs += durationMs
  return durationMs
}

export function summarizeFetchTelemetry(state: FetchTelemetryState): FetchTelemetrySummary | undefined {
  if (state.fetches === 0 || state.firstStartedAt == null || state.lastEndedAt == null)
    return undefined

  const wallMs = Math.max(0, state.lastEndedAt - state.firstStartedAt)
  return {
    fetches: state.fetches,
    maxParallel: state.maxParallel,
    parallelismRatio: wallMs > 0 ? state.totalMs / wallMs : state.fetches,
    slowestMs: state.slowestMs,
    upstreamMs: state.totalMs,
    wallMs,
  }
}

export function isFetchWaterfall(summary: FetchTelemetrySummary, options: Pick<FetchTelemetryRuntimeOptions, 'waterfallMinFetches' | 'waterfallThreshold'>): boolean {
  if (summary.fetches < options.waterfallMinFetches || summary.wallMs < options.waterfallThreshold)
    return false
  return summary.maxParallel <= 1 || summary.parallelismRatio <= MOSTLY_SEQUENTIAL_RATIO
}

export function callTelemetryHook(
  hooks: unknown,
  name: string,
  event: unknown,
): void {
  const hookBus = hooks as { callHook?: (name: string, event: unknown) => Promise<void> | void } | undefined
  try {
    const result = hookBus?.callHook?.(name, event)
    if (result && typeof (result as Promise<void>).catch === 'function') {
      void (result as Promise<void>).catch((error) => {
        console.error('[nuxt-use-query] a telemetry hook threw:', error)
      })
    }
  }
  catch (error) {
    console.error('[nuxt-use-query] a telemetry hook threw:', error)
  }
}

export function formatFetchTelemetryEvent(event: FetchTelemetryEvent): string {
  const status = event.ok ? 'completed' : 'failed'
  return joinTelemetryParts([
    `fetch ${event.method} ${event.url}`,
    `${status} in ${formatDuration(event.durationMs)}`,
    event.request ? `during ${event.request}` : undefined,
  ])
}

export function formatSlowFetchTelemetryEvent(event: SlowFetchTelemetryEvent): string {
  return joinTelemetryParts([
    `slow fetch ${event.method} ${event.url}`,
    `took ${formatDuration(event.durationMs)}`,
    `threshold ${formatDuration(event.thresholdMs)}`,
    event.request ? `during ${event.request}` : undefined,
  ])
}

export function formatFetchSummaryTelemetryEvent(event: FetchSummaryTelemetryEvent): string {
  return joinTelemetryParts([
    `fetch summary ${event.request}:`,
    `${formatCount(event.fetches, 'fetch', 'fetches')}`,
    `${formatDuration(event.wallMs)} wall`,
    `${formatDuration(event.upstreamMs)} upstream`,
    `max parallel ${event.maxParallel}`,
  ])
}

export function formatFetchWaterfallTelemetryEvent(event: FetchWaterfallTelemetryEvent): string {
  return joinTelemetryParts([
    `fetch waterfall ${event.request}:`,
    `${formatCount(event.fetches, 'fetch', 'fetches')}`,
    `${formatDuration(event.wallMs)} wall`,
    `${formatDuration(event.upstreamMs)} upstream`,
    `${formatDuration(event.slowestMs)} slowest`,
    `max parallel ${event.maxParallel}`,
    `threshold ${formatDuration(event.thresholdMs)}`,
  ])
}

export function formatQueryTelemetryStartEvent(event: QueryTelemetryStartEvent): string {
  return joinTelemetryParts([
    `query ${event.key} -> ${event.request}`,
    `started on ${formatRuntime(event)}`,
  ])
}

export function formatQueryTelemetryFinishEvent(event: QueryTelemetryFinishEvent): string {
  const status = event.status === 'success' ? 'succeeded' : 'failed'
  return joinTelemetryParts([
    `query ${event.key} -> ${event.request}`,
    `${status} in ${formatDuration(event.durationMs)}`,
    `on ${formatRuntime(event)}`,
    event.status === 'error' && event.error ? `error ${formatError(event.error)}` : undefined,
  ])
}

function numberOption(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function booleanOption(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 'true')
    return true
  if (value === false || value === 'false')
    return false
  return fallback
}

function formatDuration(ms: number): string {
  if (ms < 1_000)
    return `${Math.round(ms)}ms`
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)}s`
}

function formatCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function formatRuntime(event: Pick<QueryTelemetryStartEvent, 'client' | 'server'>): string {
  if (event.server && event.client)
    return 'server+client'
  if (event.server)
    return 'server'
  if (event.client)
    return 'client'
  return 'unknown runtime'
}

function formatError(error: unknown): string {
  if (error instanceof Error)
    return error.message
  if (typeof error === 'string')
    return error
  return '[unknown]'
}

function joinTelemetryParts(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
