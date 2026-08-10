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

function emptyTelemetryStore(): TelemetryStore {
  return {
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

export default defineEventHandler((event) => {
  const fixtureGlobal = globalThis as FixtureGlobal
  if (getQuery(event).reset)
    fixtureGlobal.__NUXT_USE_QUERY_FIXTURE_TELEMETRY__ = emptyTelemetryStore()
  return fixtureGlobal.__NUXT_USE_QUERY_FIXTURE_TELEMETRY__ ??= emptyTelemetryStore()
})
