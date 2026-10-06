declare module '#nuxt-cf-jobs/nitro' {
  export const useNitroApp: typeof import('./nitro2').useNitroApp
  export const useRuntimeConfig: typeof import('./nitro2').useRuntimeConfig
  export const defineNitroPlugin: typeof import('./nitro2').defineNitroPlugin
}
