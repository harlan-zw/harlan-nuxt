import type { DuplicateFetchTelemetryEvent, FetchSummaryTelemetryEvent, FetchTelemetryEvent, FetchTelemetryState, FetchTimeoutTelemetryEvent, FetchWaterfallTelemetryEvent, NestedFetchTelemetryEvent, RecursiveFetchTelemetryEvent, SlowFetchTelemetryEvent } from '../../telemetry'
import { consola } from 'consola'
import { defineNitroPlugin, useEvent, useRuntimeConfig } from 'nitropack/runtime'
import {
  callTelemetryHook,
  createFetchTelemetryState,
  endFetchTelemetry,
  formatDuplicateFetchTelemetryEvent,
  formatFetchSummaryTelemetryEvent,
  formatFetchTelemetryEvent,
  formatFetchTimeoutTelemetryEvent,
  formatFetchWaterfallTelemetryEvent,
  formatNestedFetchTelemetryEvent,
  formatRecursiveFetchTelemetryEvent,
  formatSlowFetchTelemetryEvent,
  isFetchWaterfall,
  normalizeFetchTelemetryOptions,
  NUXT_USE_QUERY_TELEMETRY_HOOKS,
  recordFetchTelemetry,
  resolveSlowFetchThreshold,
  startFetchTelemetry,
  summarizeFetchTelemetry,
} from '../../telemetry'

const STATE_KEY = '__nuxtUseQueryFetchTelemetry'
const WRAPPED_KEY = '__nuxtUseQueryFetchTelemetryWrapped'
const ORIGINAL_KEY = '__nuxtUseQueryFetchTelemetryOriginal'
const INTERNAL_FETCH_STACK_HEADER = 'x-nuxt-use-query-fetch-stack'
const INTERNAL_FETCH_STACK_TOKEN_HEADER = 'x-nuxt-use-query-fetch-stack-token'
const SENSITIVE_QUERY_KEY_PARTS = [
  'access-key',
  'access_key',
  'accesskey',
  'apikey',
  'api-key',
  'api_key',
  'auth',
  'cookie',
  'csrf',
  'jwt',
  'password',
  'passwd',
  'pwd',
  'secret',
  'session',
  'signature',
  'sig',
  'token',
]

type FetchLike = ((request: unknown, opts?: Record<string, unknown>) => Promise<unknown>) & {
  [ORIGINAL_KEY]?: FetchLike
  [WRAPPED_KEY]?: boolean
  create?: (...args: unknown[]) => FetchLike
  native?: unknown
  raw?: (request: unknown, opts?: Record<string, unknown>) => Promise<unknown>
}

interface FetchTelemetryRuntimeConfig {
  nuxtUseQuery?: {
    telemetry?: Parameters<typeof normalizeFetchTelemetryOptions>[0]
  }
}

const logger = consola.withTag('nuxt-use-query')

export default defineNitroPlugin((nitroApp) => {
  const options = readOptions()
  if (!options.enabled)
    return

  const internalStackToken = createInternalStackToken()
  const original = globalThis.$fetch as FetchLike | undefined
  const originalGlobalFetch = original?.[ORIGINAL_KEY] ?? original
  if (originalGlobalFetch) {
    globalThis.$fetch = wrapFetch(originalGlobalFetch, () => {
      const event = safeEvent()
      return event ? getEventState(event, internalStackToken) : undefined
    }, true) as typeof globalThis.$fetch
  }

  nitroApp.hooks.hook('request', (event) => {
    const fetchEvent = event as { $fetch?: FetchLike }
    const fetcher = fetchEvent.$fetch
    if (!fetcher) {
      return
    }
    fetchEvent.$fetch = wrapFetch(fetcher[ORIGINAL_KEY] ?? fetcher, () => getEventState(event, internalStackToken), true)
  })

  nitroApp.hooks.hook('afterResponse', async (event) => {
    const state = (event?.context as Record<string, unknown> | undefined)?.[STATE_KEY]
    if (state == null)
      return

    const summary = summarizeFetchTelemetry(state as FetchTelemetryState)
    if (summary == null)
      return

    const request = describeEvent(event)
    const summaryEvent: FetchSummaryTelemetryEvent = {
      ...summary,
      request,
      server: true,
    }
    await callTelemetryHook(nitroApp.hooks, NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchSummary, summaryEvent)

    if (options.console && options.debug) {
      logger.debug(formatFetchSummaryTelemetryEvent(summaryEvent))
    }

    if (isFetchWaterfall(summary, options)) {
      const waterfallEvent: FetchWaterfallTelemetryEvent = {
        ...summaryEvent,
        minFetches: options.waterfallMinFetches,
        thresholdMs: options.waterfallThreshold,
      }
      await callTelemetryHook(nitroApp.hooks, NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchWaterfall, waterfallEvent)
      if (options.console)
        logger.warn(formatFetchWaterfallTelemetryEvent(waterfallEvent))
    }
  })

  function wrapFetch(fetcher: FetchLike, resolveState: () => FetchTelemetryState | undefined, applyDefaultTimeout: boolean): FetchLike {
    if (fetcher[WRAPPED_KEY])
      return fetcher

    const wrapped = ((request: unknown, opts?: Record<string, unknown>) => {
      return trackFetch(request, opts, resolveState, fetchOpts => fetcher.call(globalThis, request, fetchOpts), applyDefaultTimeout)
    }) as FetchLike

    if (typeof fetcher.raw === 'function') {
      wrapped.raw = (request, opts) => {
        return trackFetch(request, opts, resolveState, fetchOpts => fetcher.raw!.call(fetcher, request, fetchOpts), applyDefaultTimeout)
      }
    }

    if (typeof fetcher.create === 'function') {
      wrapped.create = (...args) => {
        return wrapFetch(fetcher.create!.apply(fetcher, withCreatedFetchTimeout(args)), resolveState, false)
      }
    }

    if ('native' in fetcher)
      wrapped.native = fetcher.native

    wrapped[ORIGINAL_KEY] = fetcher
    wrapped[WRAPPED_KEY] = true
    return wrapped
  }

  async function trackFetch<T>(
    request: unknown,
    opts: Record<string, unknown> | undefined,
    resolveState: () => FetchTelemetryState | undefined,
    invoke: (opts: Record<string, unknown> | undefined) => Promise<T>,
    applyDefaultTimeout: boolean,
  ): Promise<T> {
    const resolved = resolveFetchOptions(opts, applyDefaultTimeout)
    const state = resolveState()
    const internalFetch = state ? trackInternalFetch(request, resolved.opts, state) : undefined
    const fetchOptions = internalFetch
      ? withInternalFetchStackHeader(resolved.opts, internalFetch.stack, internalStackToken)
      : resolved.opts
    const startedAt = Date.now()
    if (state)
      startFetchTelemetry(state, startedAt)

    try {
      const result = await invoke(fetchOptions)
      reportFetch(request, fetchOptions, startedAt, true, state, resolved.timeoutMs)
      return result
    }
    catch (error) {
      reportFetch(request, fetchOptions, startedAt, false, state, resolved.timeoutMs, error)
      throw error
    }
  }

  function reportFetch(
    request: unknown,
    opts: Record<string, unknown> | undefined,
    startedAt: number,
    ok: boolean,
    state: FetchTelemetryState | undefined,
    timeoutMs: number | undefined,
    error?: unknown,
  ): void {
    const endedAt = Date.now()
    const durationMs = state
      ? endFetchTelemetry(state, startedAt, endedAt)
      : Math.max(0, endedAt - startedAt)
    const method = describeMethod(request, opts)
    const url = describeRequest(request)
    const displayUrl = shortUrl(url)
    const timelineUrl = state
      ? describeTimelineRequest(request, opts, state)
      : displayUrl
    const event: FetchTelemetryEvent = {
      durationMs,
      ...(error !== undefined ? { error } : {}),
      method,
      ok,
      request: state?.request,
      server: true,
      url: displayUrl,
    }
    if (state) {
      recordFetchTelemetry(state, {
        durationMs,
        endedAt,
        method,
        ok,
        startedAt,
        url: timelineUrl,
      })
    }
    callTelemetryHook(nitroApp.hooks, NUXT_USE_QUERY_TELEMETRY_HOOKS.fetch, event)

    if (options.console && options.debug) {
      logger.debug(formatFetchTelemetryEvent(event))
    }

    if (!ok && timeoutMs != null && isFetchTimeoutError(error, durationMs, timeoutMs)) {
      const timeoutEvent: FetchTimeoutTelemetryEvent = {
        ...event,
        timeoutMs,
      }
      callTelemetryHook(nitroApp.hooks, NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchTimeout, timeoutEvent)
      if (options.console)
        logger.warn(formatFetchTimeoutTelemetryEvent(timeoutEvent))
    }

    const slowThreshold = readFetchSlowThreshold(opts?.slowFetchThreshold)
      ?? resolveSlowFetchThreshold(options.slowFetchThreshold, requestHost(request))
    if (ok && typeof slowThreshold === 'number' && slowThreshold > 0 && durationMs >= slowThreshold) {
      const slowEvent: SlowFetchTelemetryEvent = {
        ...event,
        thresholdMs: slowThreshold,
      }
      callTelemetryHook(nitroApp.hooks, NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchSlow, slowEvent)
      if (options.console)
        logger.warn(formatSlowFetchTelemetryEvent(slowEvent))
    }
  }

  function trackInternalFetch(
    request: unknown,
    opts: Record<string, unknown> | undefined,
    state: FetchTelemetryState,
  ): { stack: string[] } | undefined {
    const target = resolveInternalFetchTarget(request, opts, state)
    if (!target)
      return undefined

    const stack = state.internalFetchStack.length > 0
      ? state.internalFetchStack
      : state.request ? [state.request] : []
    const nextStack = [...stack, target.key]
    const depth = nextStack.length

    if (options.recursiveFetchWarning && stack.includes(target.key)) {
      const event: RecursiveFetchTelemetryEvent = {
        depth,
        method: target.method,
        request: state.request,
        server: true,
        stack: redactFetchStack(nextStack),
        url: target.url,
      }
      callTelemetryHook(nitroApp.hooks, NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchRecursive, event)
      if (options.console)
        logger.warn(formatRecursiveFetchTelemetryEvent(event))
    }

    if (options.nestedFetchDepthThreshold !== false && depth >= options.nestedFetchDepthThreshold) {
      const event: NestedFetchTelemetryEvent = {
        depth,
        method: target.method,
        request: state.request,
        server: true,
        stack: redactFetchStack(nextStack),
        threshold: options.nestedFetchDepthThreshold,
        url: target.url,
      }
      callTelemetryHook(nitroApp.hooks, NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchNested, event)
      if (options.console)
        logger.warn(formatNestedFetchTelemetryEvent(event))
    }

    if (target.method === 'GET' && options.duplicateFetchThreshold !== false) {
      const count = (state.duplicateFetchCounts[target.key] ?? 0) + 1
      state.duplicateFetchCounts[target.key] = count
      if (count >= options.duplicateFetchThreshold && !state.reportedDuplicateFetches[target.key]) {
        state.reportedDuplicateFetches[target.key] = true
        const event: DuplicateFetchTelemetryEvent = {
          count,
          method: target.method,
          request: state.request,
          server: true,
          threshold: options.duplicateFetchThreshold,
          url: target.url,
        }
        callTelemetryHook(nitroApp.hooks, NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchDuplicate, event)
        if (options.console)
          logger.warn(formatDuplicateFetchTelemetryEvent(event))
      }
    }

    return { stack: nextStack }
  }

  function resolveFetchOptions(opts: Record<string, unknown> | undefined, applyDefaultTimeout: boolean): {
    opts: Record<string, unknown> | undefined
    timeoutMs: number | undefined
  } {
    const explicitTimeout = readFetchTimeout(opts?.timeout)
    if (explicitTimeout != null) {
      return {
        opts,
        timeoutMs: explicitTimeout === false ? undefined : explicitTimeout,
      }
    }
    if (!applyDefaultTimeout || options.timeout === false)
      return { opts, timeoutMs: undefined }
    return {
      opts: {
        ...(opts ?? {}),
        timeout: options.timeout,
      },
      timeoutMs: options.timeout,
    }
  }

  function withCreatedFetchTimeout(args: unknown[]): unknown[] {
    if (options.timeout === false)
      return args
    const [defaults, ...rest] = args
    if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
      const current = defaults as Record<string, unknown>
      if (readFetchTimeout(current.timeout) != null)
        return args
      return [{ ...current, timeout: options.timeout }, ...rest]
    }
    return [{ timeout: options.timeout }, ...args]
  }
})

function readOptions() {
  try {
    const config = useRuntimeConfig() as unknown as FetchTelemetryRuntimeConfig
    return normalizeFetchTelemetryOptions(config.nuxtUseQuery?.telemetry)
  }
  catch {
    return normalizeFetchTelemetryOptions()
  }
}

function safeEvent(): any {
  try {
    return useEvent()
  }
  catch {
    return undefined
  }
}

function getEventState(event: any, internalStackToken: string): FetchTelemetryState | undefined {
  const ctx = event?.context as Record<string, unknown> | undefined
  if (ctx == null)
    return undefined
  const state = (ctx[STATE_KEY] ??= createFetchTelemetryState()) as FetchTelemetryState
  state.request ??= describeEvent(event)
  state.origin ??= describeEventOrigin(event)
  if (state.internalFetchStack.length === 0)
    state.internalFetchStack = readIncomingFetchStack(event, internalStackToken) ?? [describeEventFetchKey(event)]
  return state
}

function describeEvent(event: any): string {
  const method = event?.method ?? 'GET'
  const path = event?.path ?? event?.node?.req?.url ?? ''
  return `${method} ${redactSensitiveQueryValues(String(path))}`.trim()
}

function describeEventFetchKey(event: any): string {
  const method = String(event?.method ?? 'GET').toUpperCase()
  const path = normalizeInternalPath(event?.path ?? event?.node?.req?.url ?? '/')
  return `${method} ${path}`
}

function describeEventOrigin(event: any): string | undefined {
  const headers = event?.node?.req?.headers as Record<string, string | string[] | undefined> | undefined
  const host = headerValue(headers, 'x-forwarded-host') ?? headerValue(headers, 'host')
  if (!host)
    return undefined
  const proto = headerValue(headers, 'x-forwarded-proto') ?? 'http'
  return `${proto.split(',')[0]}://${host.split(',')[0]}`
}

function describeMethod(request: unknown, opts: Record<string, unknown> | undefined): string {
  const input = request && typeof request === 'object' && 'method' in request
    ? (request as { method?: unknown }).method
    : undefined
  return String(opts?.method ?? input ?? 'GET').toUpperCase()
}

function describeRequest(request: unknown): string {
  if (typeof request === 'string')
    return request
  if (request instanceof URL)
    return request.href
  if (request && typeof request === 'object' && 'url' in request)
    return String((request as { url: unknown }).url)
  return '[unknown]'
}

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\?.*$/, '').slice(0, 120)
}

function describeTimelineRequest(
  request: unknown,
  opts: Record<string, unknown> | undefined,
  state: FetchTelemetryState,
): string {
  const rawUrl = describeRequest(request)
  const internalPath = resolveInternalPath(rawUrl, state.origin)
  if (internalPath)
    return shortTimelineUrl(redactSensitiveQueryValues(normalizeInternalPath(withFetchQuery(internalPath, opts?.query ?? opts?.params))))
  return shortUrl(rawUrl)
}

function shortTimelineUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').slice(0, 180)
}

function resolveInternalFetchTarget(
  request: unknown,
  opts: Record<string, unknown> | undefined,
  state: FetchTelemetryState,
): { key: string, method: string, url: string } | undefined {
  const rawUrl = describeRequest(request)
  const path = resolveInternalPath(rawUrl, state.origin)
  if (!path)
    return undefined
  const method = describeMethod(request, opts)
  const normalizedPath = normalizeInternalPath(withFetchQuery(path, opts?.query ?? opts?.params))
  return {
    key: `${method} ${normalizedPath}`,
    method,
    url: shortUrl(normalizedPath),
  }
}

function withFetchQuery(path: string, query: unknown): string {
  if (!query)
    return path
  const url = new URL(path, 'http://nuxt-use-query.local')
  if (query instanceof URLSearchParams) {
    for (const [key, value] of query)
      url.searchParams.set(key, value)
  }
  else if (typeof query === 'string') {
    const params = new URLSearchParams(query)
    for (const [key, value] of params)
      url.searchParams.set(key, value)
  }
  else if (typeof query === 'object') {
    for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
      if (value == null)
        continue
      if (Array.isArray(value)) {
        url.searchParams.delete(key)
        for (const item of value)
          url.searchParams.append(key, String(item))
        continue
      }
      url.searchParams.set(key, String(value))
    }
  }
  return `${url.pathname}${url.search}`
}

function resolveInternalPath(rawUrl: string, origin: string | undefined): string | undefined {
  if (rawUrl.startsWith('/'))
    return rawUrl
  if (!origin)
    return undefined
  try {
    const url = new URL(rawUrl)
    return url.origin === origin ? `${url.pathname}${url.search}` : undefined
  }
  catch {
    return undefined
  }
}

function normalizeInternalPath(path: string): string {
  try {
    const url = new URL(path, 'http://nuxt-use-query.local')
    url.searchParams.sort()
    return `${url.pathname}${url.search}`
  }
  catch {
    return path || '/'
  }
}

function redactSensitiveQueryValues(path: string): string {
  try {
    const url = new URL(path, 'http://nuxt-use-query.local')
    let redacted = false
    for (const key of Array.from(url.searchParams.keys())) {
      if (!isSensitiveQueryKey(key))
        continue
      redacted = true
      const values = url.searchParams.getAll(key)
      url.searchParams.delete(key)
      for (const _value of values)
        url.searchParams.append(key, '[redacted]')
    }
    return redacted ? `${url.pathname}${url.search}` : path
  }
  catch {
    return path
  }
}

function isSensitiveQueryKey(key: string): boolean {
  const normalized = key.toLowerCase()
  return SENSITIVE_QUERY_KEY_PARTS.some(part => normalized.includes(part))
}

function redactFetchStack(stack: string[]): string[] {
  return stack.map((entry) => {
    const firstSpace = entry.indexOf(' ')
    if (firstSpace === -1)
      return redactSensitiveQueryValues(entry)
    return `${entry.slice(0, firstSpace)} ${redactSensitiveQueryValues(entry.slice(firstSpace + 1).trimStart())}`
  })
}

function withInternalFetchStackHeader(opts: Record<string, unknown> | undefined, stack: string[], token: string): Record<string, unknown> {
  return {
    ...(opts ?? {}),
    headers: withHeaders(opts?.headers, {
      [INTERNAL_FETCH_STACK_HEADER]: serializeFetchStack(redactFetchStack(stack)),
      [INTERNAL_FETCH_STACK_TOKEN_HEADER]: token,
    }),
  }
}

function withHeaders(headers: unknown, values: Record<string, string>): unknown {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const next = new Headers(headers)
    for (const [name, value] of Object.entries(values))
      next.set(name, value)
    return next
  }
  if (Array.isArray(headers))
    return [...headers, ...Object.entries(values)]
  if (headers && typeof headers === 'object')
    return { ...(headers as Record<string, unknown>), ...values }
  return values
}

function readIncomingFetchStack(event: any, token: string): string[] | undefined {
  if (headerValue(event?.node?.req?.headers, INTERNAL_FETCH_STACK_TOKEN_HEADER) !== token)
    return undefined
  const value = headerValue(event?.node?.req?.headers, INTERNAL_FETCH_STACK_HEADER)
  if (!value)
    return undefined
  const stack = value
    .split(',')
    .map(part => safeDecodeURIComponent(part))
    .filter(Boolean)
  return stack.length > 0 ? stack : undefined
}

function serializeFetchStack(stack: string[]): string {
  return stack.slice(-20).map(encodeURIComponent).join(',')
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  }
  catch {
    return value
  }
}

function createInternalStackToken(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object')
    return undefined
  const value = (headers as Record<string, string | string[] | undefined>)[name]
    ?? (headers as Record<string, string | string[] | undefined>)[name.toLowerCase()]
  if (Array.isArray(value))
    return value[0]
  return typeof value === 'string' ? value : undefined
}

function readFetchTimeout(value: unknown): number | false | undefined {
  if (value == null)
    return undefined
  if (value === false || value === 'false' || value === 0 || value === '0')
    return false
  const timeout = Number(value)
  return Number.isFinite(timeout) && timeout > 0 ? timeout : undefined
}

// Per-call slow-fetch threshold override (ms): `$fetch(url, { slowFetchThreshold })`.
// `false`/`0` mutes detection for that one call; `undefined` defers to the
// configured global/per-host threshold.
function readFetchSlowThreshold(value: unknown): number | false | undefined {
  if (value == null)
    return undefined
  if (value === false || value === 'false' || value === 0 || value === '0')
    return false
  const threshold = Number(value)
  return Number.isFinite(threshold) && threshold > 0 ? Math.floor(threshold) : undefined
}

// Hostname for per-host threshold lookup. Relative/internal fetches have no
// host and resolve to the map default.
function requestHost(request: unknown): string | undefined {
  const raw = describeRequest(request)
  if (raw.startsWith('/'))
    return undefined
  try {
    return new URL(raw).hostname
  }
  catch {
    return undefined
  }
}

function isFetchTimeoutError(error: unknown, durationMs: number, timeoutMs: number): boolean {
  const e = error as {
    cause?: { code?: unknown, name?: string }
    code?: unknown
    name?: string
  } | undefined
  const names = [e?.name, e?.cause?.name]
  return names.includes('TimeoutError') || e?.code === 23 || e?.cause?.code === 23 || durationMs >= timeoutMs
}
