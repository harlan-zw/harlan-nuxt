import { fileURLToPath } from 'node:url'

export default {
  resolve: {
    alias: {
      '#cf-jobs/server': fileURLToPath(new URL('./src/runtime/server/index.ts', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.e2e.test.ts'],
  },
}
