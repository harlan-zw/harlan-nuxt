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
      slowFetchThreshold: 60_000,
      waterfallThreshold: 60_000,
    },
  },
  compatibilityDate: '2025-01-01',
})
