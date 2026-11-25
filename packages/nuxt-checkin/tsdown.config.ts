import { builder } from '@nuxt/module-builder/tsdown'
import { defineConfig } from 'tsdown'

export default defineConfig({
  plugins: [
    builder({
      entries: [
        './src/cli/index',
      ],
      externals: [
        '#imports',
        'nitropack',
        'nitropack/types',
      ],
    }),
  ],
})
