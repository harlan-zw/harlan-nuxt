import type { QueryTelemetryFinishEvent, QueryTelemetryStartEvent } from './telemetry'
import { useNuxtApp, useRuntimeConfig } from '#app'
import { callTelemetryHook, NUXT_USE_QUERY_TELEMETRY_HOOKS } from './telemetry'

interface QueryTelemetryRuntimeConfig {
  public?: {
    nuxtUseQuery?: {
      telemetry?: {
        enabled?: unknown
      }
    }
  }
}

interface QueryTelemetryDescriptor {
  key: string
  request: string
}

export interface QueryTelemetryState extends QueryTelemetryDescriptor {
  finished: boolean
  startedAt: number
}

type QueryTelemetryFinish = ({
  error?: unknown
  status: 'error' | 'success'
} | {
  deadline: number
  error: unknown
  reason: 'ssr-deadline'
  status: 'deferred'
}) & (
  | { _tag: 'started', state: QueryTelemetryState }
  | { _tag: 'unstarted', descriptor: QueryTelemetryDescriptor }
)

type QueryTelemetry
  = | { _tag: 'disabled' }
    | {
      _tag: 'enabled'
      finish: (input: QueryTelemetryFinish) => void
      start: (descriptor: QueryTelemetryDescriptor) => QueryTelemetryState
    }

export function useQueryTelemetry(): QueryTelemetry {
  const config = useRuntimeConfig() as QueryTelemetryRuntimeConfig
  if (config.public?.nuxtUseQuery?.telemetry?.enabled !== true)
    return { _tag: 'disabled' }

  const hooks = useNuxtApp().hooks

  return {
    _tag: 'enabled',
    start(descriptor) {
      const state: QueryTelemetryState = {
        ...descriptor,
        finished: false,
        startedAt: Date.now(),
      }
      const event: QueryTelemetryStartEvent = {
        client: import.meta.client,
        key: state.key,
        request: state.request,
        server: import.meta.server,
        startedAt: state.startedAt,
      }
      callTelemetryHook(hooks, NUXT_USE_QUERY_TELEMETRY_HOOKS.queryStart, event)
      return state
    },
    finish(input) {
      const state = input._tag === 'started' ? input.state : undefined
      if (state?.finished)
        return
      if (state)
        state.finished = true
      const descriptor = input._tag === 'started' ? input.state : input.descriptor
      const endedAt = Date.now()
      const startedAt = state?.startedAt ?? endedAt
      const eventBase = {
        client: import.meta.client,
        durationMs: Math.max(0, endedAt - startedAt),
        endedAt,
        error: input.error,
        key: descriptor.key,
        request: descriptor.request,
        server: import.meta.server,
        startedAt,
      }
      const event: QueryTelemetryFinishEvent = input.status === 'deferred'
        ? { ...eventBase, deadline: input.deadline, reason: input.reason, status: input.status }
        : { ...eventBase, status: input.status }
      callTelemetryHook(hooks, NUXT_USE_QUERY_TELEMETRY_HOOKS.queryFinish, event)
    },
  }
}
