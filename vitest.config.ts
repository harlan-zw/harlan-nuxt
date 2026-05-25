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
    exclude: process.env.CF_JOBS_E2E === '1' ? [] : ['tests/**/*.e2e.test.ts'],
  },
}
