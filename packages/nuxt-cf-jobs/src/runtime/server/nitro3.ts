import { useNitroHooks } from 'nitro/app'

export { definePlugin as defineNitroPlugin } from 'nitro'
export { useRuntimeConfig } from 'nuxt/server'
export function useNitroApp(): { hooks: ReturnType<typeof useNitroHooks> } {
  return { hooks: useNitroHooks() }
}
