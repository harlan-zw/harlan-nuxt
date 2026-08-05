import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '#event-listeners/context': fileURLToPath(new URL('./tests/fixtures/queued-context.ts', import.meta.url)),
      '#event-listeners/server': fileURLToPath(new URL('./tests/fixtures/generated-runtime.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
  },
})
