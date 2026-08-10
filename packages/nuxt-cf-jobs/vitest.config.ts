import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

const alias = {
  '#cf-jobs/server': fileURLToPath(new URL('./src/runtime/server/index.ts', import.meta.url)),
  '#cf-jobs/cloudflare': fileURLToPath(new URL('./src/runtime/server/cloudflare.ts', import.meta.url)),
  '#cf-jobs/testing': fileURLToPath(new URL('./src/runtime/server/testing.ts', import.meta.url)),
  // The `nuxt-cf-jobs/server` barrel is nitropack-free (scheduled.ts inlines
  // defineTask), so barrel-importing unit tests don't need this. But the dev
  // nitro plugin (`plugins/dev-queues.ts`) imports `nitropack/runtime` directly,
  // which vite can't resolve outside a built nitro app. Alias it to the test
  // stub so that plugin loads under happy-dom; tests that exercise behaviour
  // `vi.mock('nitropack/runtime', …)` to inject their own runtime config.
  'nitropack/runtime': fileURLToPath(new URL('./tests/stubs/nitropack-runtime.ts', import.meta.url)),
}

export default defineConfig({
  test: {
    projects: [
      // Pure unit tests: happy-dom, runtime modules resolved from source via the
      // aliases above (with the nitropack stub).
      {
        resolve: { alias },
        test: {
          name: 'unit',
          globals: true,
          environment: 'happy-dom',
          include: ['tests/**/*.test.ts'],
          exclude: [
            ...configDefaults.exclude,
            'tests/**/*.nitro.test.ts',
            ...(process.env.CF_JOBS_E2E === '1' ? [] : ['tests/**/*.e2e.test.ts']),
          ],
        },
      },
      // Nitro integration tests (`*.nitro.test.ts`) run against a real Nitro
      // server. Config lives in its own file so nitro-test-utils owns the env.
      './tests/vitest.nitro.config.ts',
    ],
  },
})
