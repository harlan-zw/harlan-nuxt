declare module '#nuxt-wide-events/nitro' {
  export const defineNitroPlugin: typeof import('./nitro2').defineNitroPlugin
  export const useNitroApp: typeof import('./nitro2').useNitroApp
}
