import { NUXT_USE_QUERY_TELEMETRY_HOOKS } from 'nuxt-use-query/telemetry'

interface TelemetryStore {
  fetches: unknown[]
  slowFetches: unknown[]
  summaries: unknown[]
  waterfalls: unknown[]
}

type FixtureGlobal = typeof globalThis & {
  __NUXT_USE_QUERY_FIXTURE_TELEMETRY__?: TelemetryStore
}

function telemetryStore(): TelemetryStore {
  const fixtureGlobal = globalThis as FixtureGlobal
  return fixtureGlobal.__NUXT_USE_QUERY_FIXTURE_TELEMETRY__ ??= {
    fetches: [],
    slowFetches: [],
    summaries: [],
    waterfalls: [],
  }
}

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetch, (event) => {
    telemetryStore().fetches.push(event)
  })
  nitroApp.hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchSlow, (event) => {
    telemetryStore().slowFetches.push(event)
  })
  nitroApp.hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchSummary, (event) => {
    telemetryStore().summaries.push(event)
  })
  nitroApp.hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchWaterfall, (event) => {
    telemetryStore().waterfalls.push(event)
  })
})
