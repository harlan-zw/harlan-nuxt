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

export interface LargePayloadThresholdMap {
  /**
   * Default threshold (bytes) applied to hosts without a specific override.
   * `0` or `false` disables large-payload detection for un-mapped hosts.
   */
  default: number | false
  /**
   * Per-host threshold overrides (bytes), keyed by hostname (e.g. `gscdump.com`).
   * A leading `www.` is stripped before lookup. Set a host to `0`/`false` to
   * mute it entirely. Use this to silence a known-large upstream (a data/export
   * API you don't control) without desensitising every other fetch.
   */
  hosts: Record<string, number | false>
}

/**
 * Large-payload threshold in bytes, compared against the response
 * `Content-Length` header. Pass a single number to apply one threshold to every
 * outbound fetch, or a {@link LargePayloadThresholdMap} to map per-host
 * thresholds. Individual calls may override either form by passing a
 * `largePayloadThreshold` option to the tracked `$fetch`.
 *
 * Detection is header-only: it reads `Content-Length` (wire bytes, so compressed
 * when the response is encoded) and never sizes the parsed body. Responses that
 * omit the header (streamed/chunked) are silently skipped. Off by default.
 */
export type LargePayloadThreshold = number | false | LargePayloadThresholdMap

export interface FetchTelemetryRuntimeOptions {
  console: boolean
  debug: boolean
  duplicateFetchThreshold: number | false
  enabled: boolean
  largePayloadThreshold: LargePayloadThreshold
  nestedFetchDepthThreshold: number | false
  recursiveFetchWarning: boolean
  slowFetchThreshold: SlowFetchThreshold
  timeout: number | false
  /**
   * How much more the whole chain must cost than its slowest single link, in
   * ms. Keeps "one slow upstream plus a cheap follow-up" a slow-fetch story.
   */
  waterfallMinChainBeyondSlowestMs: number
  /** How many serial levels a chain needs before it is reported. */
  waterfallMinChainDepth: number
  /** Share of the wall time the chain must explain, from 0 to 1. */
  waterfallMinCriticalPathShare: number
  waterfallMinFetches: number
  waterfallThreshold: number
}

/** Repeats of one request path inside a single server render. */
export interface DuplicateFetchGroup {
  count: number
  method: string
  /** Query-stripped path, e.g. `/api/pro/sites/1/audit/pages`. */
  path: string
  /**
   * The distinct query strings seen for this path. Identical entries mean the
   * cache missed. Differing entries mean one handler ran once per variant.
   */
  variants: string[]
}

export interface FetchTelemetryState {
  active: number
  duplicateFetchGroups: Record<string, DuplicateFetchGroup>
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

export interface LargePayloadTelemetryEvent extends FetchTelemetryEvent {
  bytesLength: number
  thresholdBytes: number
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
  /** Query-stripped path. Repeats differing only by query still group here. */
  path: string
  request?: string
  server: true
  threshold: number
  variants: string[]
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

export interface FetchWaterfallTelemetryEvent extends FetchSummaryTelemetryEvent, FetchChainAnalysis {
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

export type QueryTelemetryFinishEvent = QueryTelemetryStartEvent & {
  durationMs: number
  endedAt: number
  error?: unknown
} & (
  | { status: 'error' | 'success' }
  | { deadline: number, reason: 'ssr-deadline', status: 'deferred' }
)

type TelemetryHookResult = Promise<void> | void

export interface NuxtUseQueryRuntimeNuxtHooks {
  'nuxt-use-query:telemetry:query:start': (event: QueryTelemetryStartEvent) => TelemetryHookResult
  'nuxt-use-query:telemetry:query:finish': (event: QueryTelemetryFinishEvent) => TelemetryHookResult
}

declare module 'nuxt/app' {
  interface RuntimeNuxtHooks extends NuxtUseQueryRuntimeNuxtHooks {}
}

declare module 'nitropack/types' {
  interface NitroRuntimeHooks {
    'nuxt-use-query:telemetry:fetch': (event: FetchTelemetryEvent) => TelemetryHookResult
    'nuxt-use-query:telemetry:fetch:duplicate': (event: DuplicateFetchTelemetryEvent) => TelemetryHookResult
    'nuxt-use-query:telemetry:fetch:large-payload': (event: LargePayloadTelemetryEvent) => TelemetryHookResult
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
  // 300kb mirrors Sentry's Large HTTP Payload detector. On by default; mute a
  // known-large upstream with a per-host map, `largePayloadThreshold: false`, or
  // a per-call `$fetch(url, { largePayloadThreshold: false })`.
  largePayloadThreshold: 300_000,
  nestedFetchDepthThreshold: 3,
  recursiveFetchWarning: true,
  slowFetchThreshold: 3_000,
  timeout: 20_000,
  // Validated against reconstructed production chains: depth 1 means every
  // fetch overlapped, so the render is slow because an upstream is slow. A
  // chain has to hold at least two real levels, explain most of the wall
  // time, and cost a second more than its slowest single link.
  waterfallMinChainBeyondSlowestMs: 1_000,
  waterfallMinChainDepth: 2,
  waterfallMinCriticalPathShare: 0.75,
  waterfallMinFetches: 2,
  waterfallThreshold: 3_000,
}

export const NUXT_USE_QUERY_TELEMETRY_HOOKS = {
  fetch: 'nuxt-use-query:telemetry:fetch',
  fetchDuplicate: 'nuxt-use-query:telemetry:fetch:duplicate',
  fetchLargePayload: 'nuxt-use-query:telemetry:fetch:large-payload',
  fetchNested: 'nuxt-use-query:telemetry:fetch:nested',
  fetchRecursive: 'nuxt-use-query:telemetry:fetch:recursive',
  fetchSlow: 'nuxt-use-query:telemetry:fetch:slow',
  fetchSummary: 'nuxt-use-query:telemetry:fetch:summary',
  fetchTimeout: 'nuxt-use-query:telemetry:fetch:timeout',
  fetchWaterfall: 'nuxt-use-query:telemetry:fetch:waterfall',
  queryFinish: 'nuxt-use-query:telemetry:query:finish',
  queryStart: 'nuxt-use-query:telemetry:query:start',
} as const

const TIMELINE_LIMIT = 12
const TIMELINE_WIDTH = 32

export function createFetchTelemetryState(): FetchTelemetryState {
  return {
    active: 0,
    duplicateFetchGroups: {},
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
    largePayloadThreshold: normalizeLargePayloadThreshold(input.largePayloadThreshold, DEFAULT_FETCH_TELEMETRY_OPTIONS.largePayloadThreshold),
    nestedFetchDepthThreshold: thresholdOption(input.nestedFetchDepthThreshold, DEFAULT_FETCH_TELEMETRY_OPTIONS.nestedFetchDepthThreshold),
    recursiveFetchWarning: booleanOption(input.recursiveFetchWarning, DEFAULT_FETCH_TELEMETRY_OPTIONS.recursiveFetchWarning),
    slowFetchThreshold: normalizeSlowFetchThreshold(input.slowFetchThreshold, DEFAULT_FETCH_TELEMETRY_OPTIONS.slowFetchThreshold),
    timeout: timeoutOption(input.timeout, DEFAULT_FETCH_TELEMETRY_OPTIONS.timeout),
    waterfallMinChainBeyondSlowestMs: numberOption(input.waterfallMinChainBeyondSlowestMs, DEFAULT_FETCH_TELEMETRY_OPTIONS.waterfallMinChainBeyondSlowestMs),
    waterfallMinChainDepth: numberOption(input.waterfallMinChainDepth, DEFAULT_FETCH_TELEMETRY_OPTIONS.waterfallMinChainDepth),
    waterfallMinCriticalPathShare: numberOption(input.waterfallMinCriticalPathShare, DEFAULT_FETCH_TELEMETRY_OPTIONS.waterfallMinCriticalPathShare),
    waterfallMinFetches: numberOption(input.waterfallMinFetches, DEFAULT_FETCH_TELEMETRY_OPTIONS.waterfallMinFetches),
    waterfallThreshold: numberOption(input.waterfallThreshold, DEFAULT_FETCH_TELEMETRY_OPTIONS.waterfallThreshold),
  }
}

/**
 * A configuration fault that makes a telemetry signal unreachable.
 * Discriminate on `_tag`.
 */
export interface FetchTelemetryOptionWarning {
  _tag: 'slow-fetch-threshold-above-timeout'
  /** The host the threshold applies to, absent for the default threshold. */
  host?: string
  message: string
  thresholdMs: number
  timeoutMs: number
}

/**
 * Report configuration that can never produce a signal. A slow-fetch
 * threshold at or above the fetch timeout is the known case: the request is
 * aborted before it can be reported slow, so the bar collects no rows while
 * the timeout collects every one of them.
 */
export function collectFetchTelemetryOptionWarnings(options: FetchTelemetryRuntimeOptions): FetchTelemetryOptionWarning[] {
  const timeoutMs = options.timeout
  if (timeoutMs === false)
    return []

  const warnings: FetchTelemetryOptionWarning[] = []
  const threshold = options.slowFetchThreshold
  const entries: Array<[host: string | undefined, value: number | false]> = typeof threshold === 'object'
    ? [[undefined, threshold.default], ...Object.entries(threshold.hosts).map(([host, value]) => [host, value] as [string, number | false])]
    : [[undefined, threshold]]

  for (const [host, value] of entries) {
    if (value === false || value < timeoutMs)
      continue
    warnings.push({
      _tag: 'slow-fetch-threshold-above-timeout',
      host,
      message: formatSlowFetchThresholdWarning(host, value, timeoutMs),
      thresholdMs: value,
      timeoutMs,
    })
  }
  return warnings
}

function formatSlowFetchThresholdWarning(host: string | undefined, thresholdMs: number, timeoutMs: number): string {
  const target = host ? `for ${host}` : 'default'
  return [
    `The ${target} slowFetchThreshold is ${formatDuration(thresholdMs)}.`,
    `The fetch timeout is ${formatDuration(timeoutMs)}.`,
    'A fetch aborts before it can be reported slow.',
    'Set the threshold below the timeout.',
  ].join(' ')
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

/** A fetch depends on an earlier one when it could not start until that one ended. */
export interface FetchChainAnalysis {
  /** Links on the longest dependency chain. 1 means everything overlapped. */
  chainDepth: number
  /** Short urls along that chain, in order. This is the thing to go and fix. */
  criticalPath: string[]
  /** Summed duration of the fetches on that chain. */
  criticalPathMs: number
  /** Longest single fetch anywhere in the request. */
  slowestMs: number
  /** First start to last end across every fetch. */
  wallMs: number
}

/**
 * Longest chain of fetches where each link started at or after the previous
 * one ended.
 *
 * Depth is the measure, not parallelism. A render can be 6 levels deep and 7
 * fetches wide at every level: it is highly parallel and still a waterfall,
 * because the levels run one after another. A ratio of total time to wall time
 * cannot see that, so it reports nothing on exactly the renders that hurt.
 *
 * No slack is applied. An overlap of even 1ms means two fetches were in flight
 * together, so neither waited for the other.
 */
export function analyseFetchChain(timeline: readonly FetchTelemetryTimelineEntry[]): FetchChainAnalysis {
  if (timeline.length === 0)
    return { chainDepth: 0, criticalPath: [], criticalPathMs: 0, slowestMs: 0, wallMs: 0 }

  const sorted = timeline.slice().sort(sortTimelineEntries)
  const bestMs = sorted.map(entry => entry.durationMs)
  const bestDepth = sorted.map(() => 1)
  const previous = sorted.map(() => -1)

  for (let index = 0; index < sorted.length; index++) {
    for (let earlier = 0; earlier < index; earlier++) {
      if (sorted[index]!.startedAt < sorted[earlier]!.endedAt)
        continue
      const candidate = bestMs[earlier]! + sorted[index]!.durationMs
      if (candidate > bestMs[index]!) {
        bestMs[index] = candidate
        bestDepth[index] = bestDepth[earlier]! + 1
        previous[index] = earlier
      }
    }
  }

  let end = 0
  for (let index = 1; index < sorted.length; index++) {
    if (bestMs[index]! > bestMs[end]!)
      end = index
  }

  const criticalPath: string[] = []
  for (let index = end; index !== -1; index = previous[index]!)
    criticalPath.unshift(sorted[index]!.url)

  return {
    chainDepth: bestDepth[end]!,
    criticalPath,
    criticalPathMs: bestMs[end]!,
    slowestMs: Math.max(...sorted.map(entry => entry.durationMs)),
    wallMs: Math.max(...sorted.map(entry => entry.endedAt)) - Math.min(...sorted.map(entry => entry.startedAt)),
  }
}

export function isFetchWaterfall(
  summary: FetchTelemetrySummary,
  analysis: FetchChainAnalysis,
  options: Pick<
    FetchTelemetryRuntimeOptions,
    'waterfallMinChainBeyondSlowestMs' | 'waterfallMinChainDepth' | 'waterfallMinCriticalPathShare' | 'waterfallMinFetches' | 'waterfallThreshold'
  >,
): boolean {
  if (summary.fetches < options.waterfallMinFetches || summary.wallMs < options.waterfallThreshold)
    return false
  if (analysis.chainDepth < options.waterfallMinChainDepth)
    return false
  if (analysis.criticalPathMs < options.waterfallMinCriticalPathShare * analysis.wallMs)
    return false
  return analysis.criticalPathMs - analysis.slowestMs >= options.waterfallMinChainBeyondSlowestMs
}

/**
 * Count one GET against its path and return the group it joined.
 *
 * The key drops the query string. What a render repeats is a handler, called
 * once per filtered slice, so an exact repeat of a full url is close to
 * unreachable: the query cache already coalesces those.
 */
export function recordDuplicateFetch(
  state: FetchTelemetryState,
  method: string,
  path: string,
  query: string,
): DuplicateFetchGroup {
  const key = `${method} ${path}`
  const group = state.duplicateFetchGroups[key] ?? { count: 0, method, path, variants: [] }
  group.count++
  group.variants.push(query)
  state.duplicateFetchGroups[key] = group
  return group
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

export function formatLargePayloadTelemetryEvent(event: LargePayloadTelemetryEvent): string {
  return formatTelemetryBlock('large HTTP payload', [
    ['fetch', `${event.method} ${event.url}`],
    ['size', `${formatBytes(event.bytesLength)} (threshold ${formatBytes(event.thresholdBytes)})`],
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
    ['fetch', `${event.method} ${event.path}`],
    ['count', `${event.count} (threshold ${event.threshold})`],
    ['variants', formatDuplicateVariants(event.variants)],
    event.request ? ['request', event.request] : undefined,
  ])
}

function formatDuplicateVariants(variants: string[]): string {
  const shown = variants.slice(0, 4).map(variant => variant || '(none)')
  const hidden = variants.length - shown.length
  return hidden > 0 ? `${shown.join(', ')}, ... ${hidden} more` : shown.join(', ')
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
  ], [formatWaterfallChain(event.criticalPath), formatFetchTimeline(event.timeline, event.wallMs)])
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
  return `${formatCount(event.chainDepth, 'serial level', 'serial levels')} cost ${formatDuration(event.criticalPathMs)} of ${formatDuration(event.wallMs)} wall time`
}

function formatWaterfallChain(criticalPath: string[]): string | undefined {
  if (criticalPath.length === 0)
    return undefined
  return [
    'critical path:',
    ...criticalPath.map((url, index) => `  ${index + 1}. ${url}`),
  ].join('\n')
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
  return normalizeHostThreshold(value, fallback)
}

/**
 * Resolve the effective slow-fetch threshold (ms) for a request host. A `www.`
 * prefix is stripped before lookup; un-mapped hosts (and relative/internal
 * fetches, which pass `undefined`) fall through to the map default.
 */
export function resolveSlowFetchThreshold(threshold: SlowFetchThreshold, host: string | undefined): number | false {
  return resolveHostThreshold(threshold, host)
}

/**
 * Validate a large-payload threshold option into its canonical form. Accepts a
 * number of bytes (one threshold for every host) or a per-host map; invalid
 * entries fall back to the provided default. Structurally identical to
 * {@link normalizeSlowFetchThreshold} but kept separate so the byte vs ms
 * semantics stay distinct at the type level.
 */
export function normalizeLargePayloadThreshold(value: unknown, fallback: LargePayloadThreshold): LargePayloadThreshold {
  return normalizeHostThreshold(value, fallback)
}

/**
 * Resolve the effective large-payload threshold (bytes) for a request host. A
 * `www.` prefix is stripped before lookup; un-mapped hosts (and relative/internal
 * fetches, which pass `undefined`) fall through to the map default.
 */
export function resolveLargePayloadThreshold(threshold: LargePayloadThreshold, host: string | undefined): number | false {
  return resolveHostThreshold(threshold, host)
}

interface HostThresholdMap {
  default: number | false
  hosts: Record<string, number | false>
}

type HostThreshold = number | false | HostThresholdMap

function normalizeHostThreshold(value: unknown, fallback: HostThreshold): HostThreshold {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const map = value as Partial<HostThresholdMap>
    const fallbackDefault = typeof fallback === 'object' ? fallback.default : fallback
    const hosts: Record<string, number | false> = {}
    if (map.hosts && typeof map.hosts === 'object') {
      for (const [host, threshold] of Object.entries(map.hosts)) {
        const normalized = thresholdValue(threshold)
        if (normalized != null)
          hosts[normalizeHostKey(host)] = normalized
      }
    }
    const normalizedDefault = thresholdValue(map.default)
    return {
      default: normalizedDefault ?? fallbackDefault,
      hosts,
    }
  }
  const normalized = thresholdValue(value)
  return normalized ?? fallback
}

function resolveHostThreshold(threshold: HostThreshold, host: string | undefined): number | false {
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

function thresholdValue(value: unknown): number | false | null {
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

function formatBytes(bytes: number): string {
  if (bytes < 1_024)
    return `${Math.round(bytes)} B`
  const kb = bytes / 1_024
  if (kb < 1_024)
    return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
  const mb = kb / 1_024
  return `${mb.toFixed(mb < 10 ? 2 : 1)} MB`
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
