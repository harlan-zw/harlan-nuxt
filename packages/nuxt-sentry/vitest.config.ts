import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '#nuxt-sentry/nitro': new URL('./src/runtime/server/nitro2.ts', import.meta.url).pathname } },
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
