declare module '#nuxt-sentry/nitro' {
  export const defineNitroPlugin: typeof import('./nitro2').defineNitroPlugin
  export const useRuntimeConfig: typeof import('./nitro2').useRuntimeConfig
}

declare module '#nuxt-sentry/cloudflare-sdk' {
  export { sentryCloudflareNitroPlugin } from '@sentry/nuxt/module/plugins'
}
