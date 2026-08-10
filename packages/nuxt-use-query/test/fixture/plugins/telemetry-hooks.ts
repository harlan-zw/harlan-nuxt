import type { QueryTelemetryFinishEvent } from '@harlan-zw/nuxt-use-query/telemetry'
import { NUXT_USE_QUERY_TELEMETRY_HOOKS } from '@harlan-zw/nuxt-use-query/telemetry'

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.queryFinish, (event: QueryTelemetryFinishEvent) => {
    void event
  })
})
