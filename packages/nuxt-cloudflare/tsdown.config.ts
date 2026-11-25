import { builder } from '@nuxt/module-builder/tsdown'
import { defineConfig } from 'tsdown'

export default defineConfig({
  plugins: [
    builder({
      entries: [
        './src/checks',
        './src/bindings',
        './src/cache',
        './src/d1',
        './src/d1-stats',
        './src/deploy',
        './src/storage',
        './src/wrangler',
        './src/cli/index',
      ],
    }),
  ],
})
