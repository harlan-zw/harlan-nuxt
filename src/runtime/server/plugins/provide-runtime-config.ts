// @ts-expect-error - nitropack/runtime is resolved at build time inside Nuxt
import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime'
// @ts-expect-error - #cf-jobs/app is the generated registry alias, resolved by Nuxt
import { app } from '#cf-jobs/app'

// Always-registered server plugin: injects nitro's `useRuntimeConfig` into the
// generated `#cf-jobs/app` registry. The registry itself imports nothing
// framework-bound (it loads in raw Node / the Vite build / nitro dev's external
// `file://` graph, where `nitropack/runtime`'s `#nitro-internal-virtual/*`
// virtuals don't resolve). This plugin IS bundled by nitro, so it can reach the
// runtime safely, and it runs at startup before any job dispatch.
export default defineNitroPlugin(() => {
  ;(app as { provideRuntimeConfig: (fn: typeof useRuntimeConfig) => void })
    .provideRuntimeConfig(useRuntimeConfig)
})
