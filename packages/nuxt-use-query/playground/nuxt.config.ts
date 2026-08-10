import { fileURLToPath } from 'node:url'

const telemetryAlias = fileURLToPath(new URL('../src/runtime/telemetry.ts', import.meta.url))

export default defineNuxtConfig({
  alias: {
    '@harlan-zw/nuxt-use-query/telemetry': telemetryAlias,
  },
  modules: ['../src/module'],
  compatibilityDate: '2025-01-01',
  nuxtUseQuery: {
    telemetry: {
      enabled: true,
      slowFetchThreshold: 100,
      waterfallMinFetches: 2,
      waterfallThreshold: 200,
      debug: true,
    },
  },
})
