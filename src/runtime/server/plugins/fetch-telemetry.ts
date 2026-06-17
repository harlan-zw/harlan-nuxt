import type { FetchSummaryTelemetryEvent, FetchTelemetryEvent, FetchTelemetryState, FetchWaterfallTelemetryEvent, SlowFetchTelemetryEvent } from '../../telemetry'
import { consola } from 'consola'
import { defineNitroPlugin, useEvent, useRuntimeConfig } from 'nitropack/runtime'
import {
  callTelemetryHook,
  createFetchTelemetryState,
  endFetchTelemetry,
  formatFetchSummaryTelemetryEvent,
  formatFetchTelemetryEvent,
  formatFetchWaterfallTelemetryEvent,
  formatSlowFetchTelemetryEvent,
  isFetchWaterfall,
  normalizeFetchTelemetryOptions,
  NUXT_USE_QUERY_TELEMETRY_HOOKS,
  startFetchTelemetry,
  summarizeFetchTelemetry,
} from '../../telemetry'

const STATE_KEY = '__nuxtUseQueryFetchTelemetry'
const WRAPPED_KEY = '__nuxtUseQueryFetchTelemetryWrapped'

type FetchLike = ((request: unknown, opts?: Record<string, unknown>) => Promise<unknown>) & {
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

  const original = globalThis.$fetch as FetchLike | undefined
  if (!original || original[WRAPPED_KEY])
    return

  globalThis.$fetch = wrapFetch(original, () => {
    const event = safeEvent()
    return event ? getEventState(event) : undefined
  }) as typeof globalThis.$fetch

  nitroApp.hooks.hook('request', (event) => {
    const fetchEvent = event as { $fetch?: FetchLike }
    const fetcher = fetchEvent.$fetch
    if (!fetcher || fetcher[WRAPPED_KEY]) {
      return
    }
    fetchEvent.$fetch = wrapFetch(fetcher, () => getEventState(event))
  })

  nitroApp.hooks.hook('afterResponse', (event) => {
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
    callTelemetryHook(nitroApp.hooks, NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchSummary, summaryEvent)

    if (options.debug) {
      logger.debug(formatFetchSummaryTelemetryEvent(summaryEvent))
    }

    if (isFetchWaterfall(summary, options)) {
      const waterfallEvent: FetchWaterfallTelemetryEvent = {
        ...summaryEvent,
        minFetches: options.waterfallMinFetches,
        thresholdMs: options.waterfallThreshold,
      }
      callTelemetryHook(nitroApp.hooks, NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchWaterfall, waterfallEvent)
      logger.warn(formatFetchWaterfallTelemetryEvent(waterfallEvent))
    }
  })

  function wrapFetch(fetcher: FetchLike, resolveState: () => FetchTelemetryState | undefined): FetchLike {
    if (fetcher[WRAPPED_KEY])
      return fetcher

    const wrapped = ((request: unknown, opts?: Record<string, unknown>) => {
      return trackFetch(request, opts, resolveState, () => fetcher.call(globalThis, request, opts))
    }) as FetchLike

    if (typeof fetcher.raw === 'function') {
      wrapped.raw = (request, opts) => {
        return trackFetch(request, opts, resolveState, () => fetcher.raw!.call(fetcher, request, opts))
      }
    }

    if (typeof fetcher.create === 'function') {
      wrapped.create = (...args) => {
        return wrapFetch(fetcher.create!.apply(fetcher, args), resolveState)
      }
    }

    if ('native' in fetcher)
      wrapped.native = fetcher.native

    wrapped[WRAPPED_KEY] = true
    return wrapped
  }

  async function trackFetch<T>(
    request: unknown,
    opts: Record<string, unknown> | undefined,
    resolveState: () => FetchTelemetryState | undefined,
    invoke: () => Promise<T>,
  ): Promise<T> {
    const state = resolveState()
    const startedAt = Date.now()
    if (state)
      startFetchTelemetry(state, startedAt)

    try {
      const result = await invoke()
      reportFetch(request, opts, startedAt, true, state)
      return result
    }
    catch (error) {
      reportFetch(request, opts, startedAt, false, state)
      throw error
    }
  }

  function reportFetch(
    request: unknown,
    opts: Record<string, unknown> | undefined,
    startedAt: number,
    ok: boolean,
    state: FetchTelemetryState | undefined,
  ): void {
    const endedAt = Date.now()
    const durationMs = state
      ? endFetchTelemetry(state, startedAt, endedAt)
      : Math.max(0, endedAt - startedAt)
    const method = describeMethod(request, opts)
    const url = describeRequest(request)
    const displayUrl = shortUrl(url)
    const event: FetchTelemetryEvent = {
      durationMs,
      method,
      ok,
      request: state?.request,
      server: true,
      url: displayUrl,
    }
    callTelemetryHook(nitroApp.hooks, NUXT_USE_QUERY_TELEMETRY_HOOKS.fetch, event)

    if (options.debug) {
      logger.debug(formatFetchTelemetryEvent(event))
    }

    if (options.slowFetchThreshold > 0 && durationMs >= options.slowFetchThreshold) {
      const slowEvent: SlowFetchTelemetryEvent = {
        ...event,
        thresholdMs: options.slowFetchThreshold,
      }
      callTelemetryHook(nitroApp.hooks, NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchSlow, slowEvent)
      logger.warn(formatSlowFetchTelemetryEvent(slowEvent))
    }
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

function getEventState(event: any): FetchTelemetryState | undefined {
  const ctx = event?.context as Record<string, unknown> | undefined
  if (ctx == null)
    return undefined
  const state = (ctx[STATE_KEY] ??= createFetchTelemetryState()) as FetchTelemetryState
  state.request ??= describeEvent(event)
  return state
}

function describeEvent(event: any): string {
  const method = event?.method ?? 'GET'
  const path = event?.path ?? event?.node?.req?.url ?? ''
  return `${method} ${path}`.trim()
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
