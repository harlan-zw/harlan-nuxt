import { useRuntimeConfig } from '@harlan-zw/nuxt-cf-jobs/nitro'

/** Nitro adapter selected through `nitro.alias` at the registry usage boundary. */
export function useJobRuntimeConfig(_event?: unknown): ReturnType<typeof useRuntimeConfig> {
  return useRuntimeConfig()
}
