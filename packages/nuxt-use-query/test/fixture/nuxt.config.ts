import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'pathe'

const here = dirname(fileURLToPath(import.meta.url))
const telemetryAlias = resolve(here, '../../src/runtime/telemetry.ts')

export default defineNuxtConfig({
  alias: {
    'nuxt-use-query/telemetry': telemetryAlias,
  },
  modules: [resolve(here, '../../src/module.ts')],
  nuxtUseQuery: {
    telemetry: {
      console: false,
      slowFetchThreshold: 60_000,
      timeout: 100,
      waterfallThreshold: 60_000,
    },
  },
  compatibilityDate: '2025-01-01',
})
