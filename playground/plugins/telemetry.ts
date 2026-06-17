import {
  formatQueryTelemetryFinishEvent,
  formatQueryTelemetryStartEvent,
  NUXT_USE_QUERY_TELEMETRY_HOOKS,
} from 'nuxt-use-query/telemetry'

export default defineNuxtPlugin((nuxtApp) => {
  if (!import.meta.dev)
    return

  nuxtApp.hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.queryStart, (event) => {
    logTelemetry(formatQueryTelemetryStartEvent(event))
  })
  nuxtApp.hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.queryFinish, (event) => {
    logTelemetry(formatQueryTelemetryFinishEvent(event))
  })
})

function logTelemetry(message: string): void {
  if (import.meta.server) {
    process.stdout.write(`[nuxt-use-query playground] ${message}\n`)
    return
  }
  // Playground-only browser hook visibility.
  // eslint-disable-next-line no-console
  console.info(`[nuxt-use-query playground] ${message}`)
}
