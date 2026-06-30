export interface SlowFetchThresholdMap {
  /**
   * Default threshold (ms) applied to hosts without a specific override.
   * `0` or `false` disables slow-fetch detection for un-mapped hosts.
   */
  default: number | false
  /**
   * Per-host threshold overrides (ms), keyed by hostname (e.g. `gscdump.com`).
   * A leading `www.` is stripped before lookup. Set a host to `0`/`false` to
   * mute it entirely. Use this to raise the bar for a known-slow upstream
   * without desensitising detection for every other fetch.
   */
  hosts: Record<string, number | false>
}

/**
 * Slow-fetch threshold in milliseconds. Pass a single number to apply one
 * threshold to every outbound fetch, or a {@link SlowFetchThresholdMap} to map
 * per-host thresholds. Individual calls may override either form by passing a
 * `slowFetchThreshold` option to the tracked `$fetch`.
 */
export type SlowFetchThreshold = number | false | SlowFetchThresholdMap

export interface FetchTelemetryRuntimeOptions {
  console: boolean
  debug: boolean
  duplicateFetchThreshold: number | false
  enabled: boolean
  nestedFetchDepthThreshold: number | false
  recursiveFetchWarning: boolean
  slowFetchThreshold: SlowFetchThreshold
  timeout: number | false
  waterfallMinFetches: number
  waterfallThreshold: number
}

export interface FetchTelemetryState {
  active: number
  duplicateFetchCounts: Record<string, number>
  fetches: number
  firstStartedAt: number | undefined
  internalFetchStack: string[]
  lastEndedAt: number | undefined
  maxParallel: number
  origin: string | undefined
  reportedDuplicateFetches: Record<string, true>
  request: string | undefined
  slowestMs: number
  timeline: FetchTelemetryTimelineEntry[]
  totalMs: number
}

export interface FetchTelemetryTimelineEntry {
  durationMs: number
  endedAt: number
  method: string
  offsetMs: number
  ok: boolean
  startedAt: number
  url: string
}

export interface FetchTelemetrySummary {
  fetches: number
  maxParallel: number
  parallelismRatio: number
  slowestMs: number
  timeline: FetchTelemetryTimelineEntry[]
  upstreamMs: number
  wallMs: number
}

export interface FetchTelemetryEvent {
  durationMs: number
  error?: unknown
  method: string
  ok: boolean
  request?: string
  server: true
  url: string
}

export interface SlowFetchTelemetryEvent extends FetchTelemetryEvent {
  thresholdMs: number
}

export interface FetchTimeoutTelemetryEvent extends FetchTelemetryEvent {
  timeoutMs: number
}

export interface NestedFetchTelemetryEvent {
  depth: number
  method: string
  request?: string
  server: true
  stack: string[]
  threshold: number
  url: string
}

export interface DuplicateFetchTelemetryEvent {
  count: number
  method: string
  request?: string
  server: true
  threshold: number
  url: string
}

export interface RecursiveFetchTelemetryEvent {
  depth: number
  method: string
  request?: string
  server: true
  stack: string[]
  url: string
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
    'nuxt-use-query:telemetry:fetch:duplicate': (event: DuplicateFetchTelemetryEvent) => TelemetryHookResult
    'nuxt-use-query:telemetry:fetch:nested': (event: NestedFetchTelemetryEvent) => TelemetryHookResult
    'nuxt-use-query:telemetry:fetch:recursive': (event: RecursiveFetchTelemetryEvent) => TelemetryHookResult
    'nuxt-use-query:telemetry:fetch:slow': (event: SlowFetchTelemetryEvent) => TelemetryHookResult
    'nuxt-use-query:telemetry:fetch:summary': (event: FetchSummaryTelemetryEvent) => TelemetryHookResult
    'nuxt-use-query:telemetry:fetch:timeout': (event: FetchTimeoutTelemetryEvent) => TelemetryHookResult
    'nuxt-use-query:telemetry:fetch:waterfall': (event: FetchWaterfallTelemetryEvent) => TelemetryHookResult
  }
}

export const DEFAULT_FETCH_TELEMETRY_OPTIONS: FetchTelemetryRuntimeOptions = {
  console: true,
  debug: false,
  duplicateFetchThreshold: 2,
  enabled: true,
  nestedFetchDepthThreshold: 3,
  recursiveFetchWarning: true,
  slowFetchThreshold: 3_000,
  timeout: 20_000,
  waterfallMinFetches: 2,
  waterfallThreshold: 3_000,
}

export const NUXT_USE_QUERY_TELEMETRY_HOOKS = {
  fetch: 'nuxt-use-query:telemetry:fetch',
  fetchDuplicate: 'nuxt-use-query:telemetry:fetch:duplicate',
  fetchNested: 'nuxt-use-query:telemetry:fetch:nested',
  fetchRecursive: 'nuxt-use-query:telemetry:fetch:recursive',
  fetchSlow: 'nuxt-use-query:telemetry:fetch:slow',
  fetchSummary: 'nuxt-use-query:telemetry:fetch:summary',
  fetchTimeout: 'nuxt-use-query:telemetry:fetch:timeout',
  fetchWaterfall: 'nuxt-use-query:telemetry:fetch:waterfall',
  queryFinish: 'nuxt-use-query:telemetry:query:finish',
  queryStart: 'nuxt-use-query:telemetry:query:start',
} as const

const MOSTLY_SEQUENTIAL_RATIO = 1.25
const TIMELINE_LIMIT = 12
const TIMELINE_WIDTH = 32

export function createFetchTelemetryState(): FetchTelemetryState {
  return {
    active: 0,
    duplicateFetchCounts: {},
    fetches: 0,
    firstStartedAt: undefined,
    internalFetchStack: [],
    lastEndedAt: undefined,
    maxParallel: 0,
    origin: undefined,
    reportedDuplicateFetches: {},
    request: undefined,
    slowestMs: 0,
    timeline: [],
    totalMs: 0,
  }
}

export function normalizeFetchTelemetryOptions(input: Partial<FetchTelemetryRuntimeOptions> = {}): FetchTelemetryRuntimeOptions {
  return {
    console: booleanOption(input.console, DEFAULT_FETCH_TELEMETRY_OPTIONS.console),
    debug: booleanOption(input.debug, DEFAULT_FETCH_TELEMETRY_OPTIONS.debug),
    duplicateFetchThreshold: thresholdOption(input.duplicateFetchThreshold, DEFAULT_FETCH_TELEMETRY_OPTIONS.duplicateFetchThreshold),
    enabled: booleanOption(input.enabled, DEFAULT_FETCH_TELEMETRY_OPTIONS.enabled),
    nestedFetchDepthThreshold: thresholdOption(input.nestedFetchDepthThreshold, DEFAULT_FETCH_TELEMETRY_OPTIONS.nestedFetchDepthThreshold),
    recursiveFetchWarning: booleanOption(input.recursiveFetchWarning, DEFAULT_FETCH_TELEMETRY_OPTIONS.recursiveFetchWarning),
    slowFetchThreshold: normalizeSlowFetchThreshold(input.slowFetchThreshold, DEFAULT_FETCH_TELEMETRY_OPTIONS.slowFetchThreshold),
    timeout: timeoutOption(input.timeout, DEFAULT_FETCH_TELEMETRY_OPTIONS.timeout),
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

export function recordFetchTelemetry(state: FetchTelemetryState, entry: Omit<FetchTelemetryTimelineEntry, 'offsetMs'>): void {
  const firstStartedAt = state.firstStartedAt ?? entry.startedAt
  state.timeline.push({
    ...entry,
    offsetMs: Math.max(0, entry.startedAt - firstStartedAt),
  })
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
    timeline: state.timeline.slice().sort(sortTimelineEntries),
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
): Promise<void> | void {
  const hookBus = hooks as { callHook?: (name: string, event: unknown) => Promise<void> | void } | undefined
  try {
    const result = hookBus?.callHook?.(name, event)
    if (result && typeof (result as Promise<void>).catch === 'function') {
      return (result as Promise<void>).catch((error) => {
        console.error('[nuxt-use-query] a telemetry hook threw:', error)
      })
    }
    return result
  }
  catch (error) {
    console.error('[nuxt-use-query] a telemetry hook threw:', error)
  }
}

export function formatFetchTelemetryEvent(event: FetchTelemetryEvent): string {
  return formatTelemetryBlock(event.ok ? 'server fetch completed' : 'server fetch failed', [
    ['fetch', `${event.method} ${event.url}`],
    ['duration', formatDuration(event.durationMs)],
    event.request ? ['request', event.request] : undefined,
    !event.ok && event.error ? ['error', formatError(event.error)] : undefined,
  ])
}

export function formatSlowFetchTelemetryEvent(event: SlowFetchTelemetryEvent): string {
  return formatTelemetryBlock('slow server fetch', [
    ['fetch', `${event.method} ${event.url}`],
    ['duration', `${formatDuration(event.durationMs)} (threshold ${formatDuration(event.thresholdMs)})`],
    event.request ? ['request', event.request] : undefined,
  ])
}

export function formatFetchTimeoutTelemetryEvent(event: FetchTimeoutTelemetryEvent): string {
  return formatTelemetryBlock('server fetch timed out', [
    ['fetch', `${event.method} ${event.url}`],
    ['duration', formatDuration(event.durationMs)],
    ['timeout', formatDuration(event.timeoutMs)],
    event.request ? ['request', event.request] : undefined,
    event.error ? ['error', formatError(event.error)] : undefined,
  ])
}

export function formatNestedFetchTelemetryEvent(event: NestedFetchTelemetryEvent): string {
  return formatTelemetryBlock('nested server fetch', [
    ['fetch', `${event.method} ${event.url}`],
    ['depth', `${event.depth} (threshold ${event.threshold})`],
    event.request ? ['request', event.request] : undefined,
  ], [formatFetchStack(event.stack)])
}

export function formatDuplicateFetchTelemetryEvent(event: DuplicateFetchTelemetryEvent): string {
  return formatTelemetryBlock('duplicate server fetch', [
    ['fetch', `${event.method} ${event.url}`],
    ['count', `${event.count} (threshold ${event.threshold})`],
    event.request ? ['request', event.request] : undefined,
  ])
}

export function formatRecursiveFetchTelemetryEvent(event: RecursiveFetchTelemetryEvent): string {
  return formatTelemetryBlock('recursive server fetch', [
    ['fetch', `${event.method} ${event.url}`],
    ['depth', String(event.depth)],
    event.request ? ['request', event.request] : undefined,
  ], [formatFetchStack(event.stack)])
}

export function formatFetchSummaryTelemetryEvent(event: FetchSummaryTelemetryEvent): string {
  return formatTelemetryBlock('server fetch summary', [
    ['request', event.request],
    ...formatFetchMetricRows(event),
  ], [formatFetchTimeline(event.timeline, event.wallMs)])
}

export function formatFetchWaterfallTelemetryEvent(event: FetchWaterfallTelemetryEvent): string {
  return formatTelemetryBlock('likely server fetch waterfall', [
    ['request', event.request],
    ['reason', formatWaterfallReason(event)],
    ...formatFetchMetricRows(event),
    ['threshold', `${formatDuration(event.thresholdMs)} wall, ${formatCount(event.minFetches, 'fetch', 'fetches')}`],
    ['next step', 'Start independent fetches together with Promise.all, or combine shared data in one server endpoint.'],
  ], [formatFetchTimeline(event.timeline, event.wallMs)])
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

type TelemetryRow = [label: string, value: string] | undefined

function formatTelemetryBlock(title: string, rows: TelemetryRow[], sections: Array<string | undefined> = []): string {
  const resolvedRows = rows.filter((row): row is [label: string, value: string] => row != null)
  const labelWidth = resolvedRows.reduce((width, [label]) => Math.max(width, label.length), 0)
  const rowLines = resolvedRows.map(([label, value]) => `  ${label.padEnd(labelWidth)}: ${value}`)
  const sectionLines = sections
    .filter((section): section is string => Boolean(section))
    .map(indentTelemetrySection)
  return [title, ...rowLines, ...sectionLines].join('\n')
}

function formatFetchMetricRows(event: FetchTelemetrySummary): TelemetryRow[] {
  return [
    ['fetches', formatCount(event.fetches, 'fetch', 'fetches')],
    ['wall time', formatDuration(event.wallMs)],
    ['upstream time', `${formatDuration(event.upstreamMs)} (${formatParallelismRatio(event.parallelismRatio)}x wall)`],
    ['slowest fetch', formatDuration(event.slowestMs)],
    ['parallelism', `max ${event.maxParallel}`],
  ]
}

function formatWaterfallReason(event: FetchWaterfallTelemetryEvent): string {
  if (event.maxParallel <= 1)
    return 'tracked fetches ran one at a time'
  return `mostly sequential; parallelism only reached ${formatParallelismRatio(event.parallelismRatio)}x`
}

function formatFetchTimeline(timeline: FetchTelemetryTimelineEntry[] | undefined, wallMs: number): string | undefined {
  if (!timeline?.length)
    return undefined

  const entries = timeline.slice().sort(sortTimelineEntries)
  const visibleEntries = entries.slice(0, TIMELINE_LIMIT)
  const lines = [
    `timeline (${formatDuration(0)} -> ${formatDuration(wallMs)}):`,
    `  ${'start'.padStart(8)} ${'duration'.padStart(8)} ${'result'.padEnd(6)} ${'span'.padEnd(TIMELINE_WIDTH + 2)} fetch`,
  ]

  for (const entry of visibleEntries) {
    lines.push([
      `  ${formatTimelineOffset(entry.offsetMs).padStart(8)}`,
      formatDuration(entry.durationMs).padStart(8),
      formatTimelineResult(entry).padEnd(6),
      formatTimelineBar(entry, wallMs),
      formatTimelineTarget(entry),
    ].join(' '))
  }

  const hiddenEntries = entries.length - visibleEntries.length
  if (hiddenEntries > 0)
    lines.push(`  ... ${formatCount(hiddenEntries, 'more fetch', 'more fetches')}`)

  return lines.join('\n')
}

function formatFetchStack(stack: string[]): string | undefined {
  if (stack.length === 0)
    return undefined
  return [
    'stack:',
    ...stack.map((entry, index) => `  ${index + 1}. ${entry}`),
  ].join('\n')
}

function indentTelemetrySection(section: string): string {
  return section
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n')
}

function formatTimelineBar(entry: FetchTelemetryTimelineEntry, wallMs: number): string {
  const mark = entry.ok ? '#' : '!'
  if (wallMs <= 0)
    return `[${mark.repeat(TIMELINE_WIDTH)}]`

  const start = clamp(Math.floor((entry.offsetMs / wallMs) * TIMELINE_WIDTH), 0, TIMELINE_WIDTH - 1)
  const end = clamp(Math.ceil(((entry.offsetMs + Math.max(entry.durationMs, 1)) / wallMs) * TIMELINE_WIDTH), start + 1, TIMELINE_WIDTH)
  let output = ''
  for (let index = 0; index < TIMELINE_WIDTH; index++)
    output += index >= start && index < end ? mark : '-'
  return `[${output}]`
}

function formatTimelineOffset(ms: number): string {
  return `+${formatDuration(ms)}`
}

function formatTimelineResult(entry: FetchTelemetryTimelineEntry): string {
  return entry.ok ? 'ok' : 'failed'
}

function formatTimelineTarget(entry: FetchTelemetryTimelineEntry): string {
  const target = `${entry.method} ${entry.url}`
  return target.length > 140 ? `${target.slice(0, 137)}...` : target
}

function formatParallelismRatio(value: number): string {
  return value.toFixed(value < 10 ? 2 : 1)
}

function sortTimelineEntries(a: FetchTelemetryTimelineEntry, b: FetchTelemetryTimelineEntry): number {
  return a.startedAt - b.startedAt || a.endedAt - b.endedAt
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
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

function timeoutOption(value: unknown, fallback: number | false): number | false {
  if (value === false || value === 'false' || value === 0 || value === '0')
    return false
  const number = Number(value)
  if (Number.isFinite(number) && number > 0)
    return number
  return fallback
}

function thresholdOption(value: unknown, fallback: number | false): number | false {
  if (value === false || value === 'false' || value === 0 || value === '0')
    return false
  const number = Number(value)
  if (Number.isFinite(number) && number > 0)
    return Math.floor(number)
  return fallback
}

/**
 * Validate a slow-fetch threshold option into its canonical form. Accepts a
 * number (one threshold for every host) or a per-host map; invalid entries fall
 * back to the provided default so a malformed config can never silence
 * detection outright.
 */
export function normalizeSlowFetchThreshold(value: unknown, fallback: SlowFetchThreshold): SlowFetchThreshold {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const map = value as Partial<SlowFetchThresholdMap>
    const fallbackDefault = typeof fallback === 'object' ? fallback.default : fallback
    const hosts: Record<string, number | false> = {}
    if (map.hosts && typeof map.hosts === 'object') {
      for (const [host, threshold] of Object.entries(map.hosts)) {
        const normalized = slowThresholdValue(threshold)
        if (normalized != null)
          hosts[normalizeHostKey(host)] = normalized
      }
    }
    const normalizedDefault = slowThresholdValue(map.default)
    return {
      default: normalizedDefault ?? fallbackDefault,
      hosts,
    }
  }
  const normalized = slowThresholdValue(value)
  return normalized ?? fallback
}

/**
 * Resolve the effective slow-fetch threshold (ms) for a request host. A `www.`
 * prefix is stripped before lookup; un-mapped hosts (and relative/internal
 * fetches, which pass `undefined`) fall through to the map default.
 */
export function resolveSlowFetchThreshold(threshold: SlowFetchThreshold, host: string | undefined): number | false {
  if (threshold === false)
    return false
  if (typeof threshold === 'number')
    return threshold
  if (host) {
    const key = normalizeHostKey(host)
    const hostThreshold = threshold.hosts[key]
    if (hostThreshold !== undefined)
      return hostThreshold
  }
  return threshold.default
}

function slowThresholdValue(value: unknown): number | false | null {
  if (value === false || value === 'false' || value === 0 || value === '0')
    return false
  const number = Number(value)
  if (Number.isFinite(number) && number > 0)
    return Math.floor(number)
  return null
}

function normalizeHostKey(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, '')
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
