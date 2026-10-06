import { useNitroHooks } from 'nitro/app'

export { definePlugin as defineNitroPlugin } from 'nitro'
export { useRuntimeConfig } from 'nuxt/server'
export function useNitroApp() {
  return { hooks: useNitroHooks() }
}
