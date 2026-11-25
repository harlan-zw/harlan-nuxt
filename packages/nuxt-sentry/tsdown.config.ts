import { builder } from '@nuxt/module-builder/tsdown'
import { defineConfig } from 'tsdown'

export default defineConfig({
  plugins: [
    builder({
      entries: [
        './src/checks',
      ],
      externals: [
        '#app',
        '#imports',
        '@sentry/cloudflare',
        '@sentry/nuxt',
        '@sentry/nuxt/module/plugins',
        'nitropack',
        'nitropack/runtime',
        'nitropack/types',
      ],
    }),
  ],
})
