// @ts-expect-error resolved only when Nitro bundles the generated registry
import { useRuntimeConfig } from '#nuxt-cf-jobs/nitro'

/** Nitro adapter selected through `nitro.alias` at the registry usage boundary. */
export function useJobRuntimeConfig(_event?: unknown): ReturnType<typeof useRuntimeConfig> {
  return useRuntimeConfig()
}
