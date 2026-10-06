declare module '#nuxt-cloudflare/nitro' {
  export const defineNitroPlugin: typeof import('./nitro2').defineNitroPlugin
  export const useRuntimeConfig: typeof import('./nitro2').useRuntimeConfig
}
