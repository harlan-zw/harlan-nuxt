declare module '#nuxt-cloudflare/nitro' {
  export const defineNitroPlugin: typeof import('./nitro2').defineNitroPlugin
  export const defineNitroAppPlugin: typeof import('./nitro2').defineNitroAppPlugin
  export const useRuntimeConfig: typeof import('./nitro2').useRuntimeConfig
  export const currentRequest: typeof import('./nitro2').currentRequest
}
