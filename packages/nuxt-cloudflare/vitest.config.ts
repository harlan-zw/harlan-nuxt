import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '#nuxt-cloudflare/nitro': new URL('./src/runtime/server/nitro2.ts', import.meta.url).pathname } },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
