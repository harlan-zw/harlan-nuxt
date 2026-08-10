import { NUXT_USE_QUERY_TELEMETRY_HOOKS } from '@harlan-zw/nuxt-use-query/telemetry'

interface TelemetryStore {
  duplicates: unknown[]
  fetches: unknown[]
  nested: unknown[]
  recursive: unknown[]
  slowFetches: unknown[]
  summaries: unknown[]
  timeouts: unknown[]
  waterfalls: unknown[]
}

type FixtureGlobal = typeof globalThis & {
  __NUXT_USE_QUERY_FIXTURE_TELEMETRY__?: TelemetryStore
}

function telemetryStore(): TelemetryStore {
  const fixtureGlobal = globalThis as FixtureGlobal
  return fixtureGlobal.__NUXT_USE_QUERY_FIXTURE_TELEMETRY__ ??= {
    duplicates: [],
    fetches: [],
    nested: [],
    recursive: [],
    slowFetches: [],
    summaries: [],
    timeouts: [],
    waterfalls: [],
  }
}

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchDuplicate, (event) => {
    telemetryStore().duplicates.push(event)
  })
  nitroApp.hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetch, (event) => {
    telemetryStore().fetches.push(event)
  })
  nitroApp.hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchNested, (event) => {
    telemetryStore().nested.push(event)
  })
  nitroApp.hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchRecursive, (event) => {
    telemetryStore().recursive.push(event)
  })
  nitroApp.hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchSlow, (event) => {
    telemetryStore().slowFetches.push(event)
  })
  nitroApp.hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchSummary, (event) => {
    telemetryStore().summaries.push(event)
  })
  nitroApp.hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchTimeout, (event) => {
    telemetryStore().timeouts.push(event)
  })
  nitroApp.hooks.hook(NUXT_USE_QUERY_TELEMETRY_HOOKS.fetchWaterfall, (event) => {
    telemetryStore().waterfalls.push(event)
  })
})
