declare module '#nuxt-use-query/nitro' {
  export const defineNitroPlugin: typeof import('./nitro2').defineNitroPlugin
  export const useEvent: typeof import('./nitro2').useEvent
  export const useRuntimeConfig: typeof import('./nitro2').useRuntimeConfig
}
