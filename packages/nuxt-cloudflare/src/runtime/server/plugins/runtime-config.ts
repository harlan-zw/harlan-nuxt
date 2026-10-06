import { provideCloudflareRuntimeConfig } from '@harlan-zw/nuxt-cloudflare/bindings'
import { defineNitroPlugin, useRuntimeConfig } from '#nuxt-cloudflare/nitro'

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
