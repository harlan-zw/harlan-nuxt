import type { QueryTelemetryFinishEvent } from '@harlanzw/nuxt-use-query/telemetry'
import { NUXT_USE_QUERY_TELEMETRY_HOOKS } from '@harlanzw/nuxt-use-query/telemetry'

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.queryFinish, (event: QueryTelemetryFinishEvent) => {
    void event
  })
})
