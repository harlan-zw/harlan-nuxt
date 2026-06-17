interface TelemetryStore {
  fetches: unknown[]
  slowFetches: unknown[]
  summaries: unknown[]
  waterfalls: unknown[]
}

type FixtureGlobal = typeof globalThis & {
  __NUXT_USE_QUERY_FIXTURE_TELEMETRY__?: TelemetryStore
}

function emptyTelemetryStore(): TelemetryStore {
  return {
    fetches: [],
    slowFetches: [],
    summaries: [],
    waterfalls: [],
  }
}

export default defineEventHandler((event) => {
  const fixtureGlobal = globalThis as FixtureGlobal
  if (getQuery(event).reset)
    fixtureGlobal.__NUXT_USE_QUERY_FIXTURE_TELEMETRY__ = emptyTelemetryStore()
  return fixtureGlobal.__NUXT_USE_QUERY_FIXTURE_TELEMETRY__ ??= emptyTelemetryStore()
})
