import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime'
import { provideCloudflareRuntimeConfig } from '../../../bindings'

/**
 * Hands Nitro's runtime config reader to `useCloudflareRuntimeConfig`.
 *
 * Nitro bundles its plugins, so this file resolves `nitropack/runtime`. The
 * bindings module cannot: applications import it outside a Nitro bundle, where
 * that specifier fails to resolve.
 */
export default defineNitroPlugin(() => {
  provideCloudflareRuntimeConfig(useRuntimeConfig)
})
