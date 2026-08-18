import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'pathe'

const here = dirname(fileURLToPath(import.meta.url))
const telemetryAlias = resolve(here, '../../src/runtime/telemetry.ts')

export default defineNuxtConfig({
  alias: {
    '@harlan-zw/nuxt-use-query/telemetry': telemetryAlias,
  },
  modules: [resolve(here, '../../src/module.ts')],
  nuxtUseQuery: {
    telemetry: {
      console: false,
      // The fixture drives timeouts, not slow fetches. `false` mutes slow
      // detection; a threshold above the timeout would only be dead config.
      slowFetchThreshold: false,
      timeout: 100,
      waterfallThreshold: 60_000,
    },
  },
  compatibilityDate: '2025-01-01',
})
