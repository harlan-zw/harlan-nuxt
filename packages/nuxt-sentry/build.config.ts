import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  failOnWarn: false,
  entries: ['src/module'],
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
})
