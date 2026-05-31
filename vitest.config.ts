import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

const alias = {
  '#cf-jobs/server': fileURLToPath(new URL('./src/runtime/server/index.ts', import.meta.url)),
  '#cf-jobs/testing': fileURLToPath(new URL('./src/runtime/server/testing.ts', import.meta.url)),
  // No `nitropack/runtime` stub needed: the `nuxt-cf-jobs/server` barrel is
  // nitropack-free (scheduled.ts inlines defineTask), so barrel-importing unit
  // tests load in plain vitest with no stub.
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
