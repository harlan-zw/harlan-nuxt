// @ts-expect-error - nitropack/runtime is resolved at build time inside Nuxt
import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime'
import { provideJobRuntimeConfig } from '../runtime-config'

// Optional host adapter for direct `useJobRuntimeConfig` consumers. The Nuxt
// module does not register this globally; its generated registry injects the
// auto import at its own usage boundary.
// Neither may import `nitropack/runtime` at module-top: they load in raw
// Node / the Vite build / nitro dev's external `file://` graph, where
// `nitropack/runtime`'s `#nitro-internal-virtual/*` virtuals don't resolve (a
// module-top import there crashes the dev server at boot). This plugin IS
// bundled by nitro, so it can reach the runtime safely, and it runs at startup
// before any job dispatch.
export default defineNitroPlugin(() => {
  provideJobRuntimeConfig(useRuntimeConfig)
})
