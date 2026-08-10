// @ts-expect-error resolved only when Nitro bundles the generated registry
import { useRuntimeConfig } from 'nitropack/runtime'

/** Nitro adapter selected through `nitro.alias` at the registry usage boundary. */
export function useJobRuntimeConfig(event?: unknown): ReturnType<typeof useRuntimeConfig> {
  return useRuntimeConfig(event as never)
}
