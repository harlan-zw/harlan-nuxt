import { builder } from '@nuxt/module-builder/tsdown'
import { defineConfig } from 'tsdown'

export default defineConfig({
  plugins: [
    builder({
      entries: [
        './src/checks',
        './src/cli/index',
      ],
      externals: [
        '#app',
        '#imports',
        'node:sqlite',
        'nitropack',
        'nitropack/types',
      ],
    }),
  ],
})
