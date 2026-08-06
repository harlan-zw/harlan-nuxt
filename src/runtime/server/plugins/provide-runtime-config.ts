// @ts-expect-error - nitropack/runtime is resolved at build time inside Nuxt
import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime'
import { provideJobRuntimeConfig } from '../runtime-config'

// Always-registered server plugin: injects nitro's `useRuntimeConfig` into the
// standalone provider used by the generated registry and runtime helpers.
// Neither may import `nitropack/runtime` at module-top: they load in raw
// Node / the Vite build / nitro dev's external `file://` graph, where
// `nitropack/runtime`'s `#nitro-internal-virtual/*` virtuals don't resolve (a
// module-top import there crashes the dev server at boot). This plugin IS
// bundled by nitro, so it can reach the runtime safely, and it runs at startup
// before any job dispatch.
export default defineNitroPlugin(() => {
  provideJobRuntimeConfig(useRuntimeConfig)
})
