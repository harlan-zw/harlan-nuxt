import type { QueryTelemetryFinishEvent } from 'nuxt-use-query/telemetry'
import { NUXT_USE_QUERY_TELEMETRY_HOOKS } from 'nuxt-use-query/telemetry'

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.queryFinish, (event: QueryTelemetryFinishEvent) => {
    void event
  })
})
