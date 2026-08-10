import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineVitestConfig } from '@nuxt/test-utils/config'
import { defineConfig, defineProject } from 'vitest/config'

const rootDir = dirname(fileURLToPath(import.meta.url))
const r = (path: string) => resolve(rootDir, path)

const packageAliases = {
  '@harlan-zw/nuxt-use-query/async-query': r('src/runtime/composables/useNuxtAsyncQuery.ts'),
  '@harlan-zw/nuxt-use-query/cache': r('src/runtime/cache.ts'),
  '@harlan-zw/nuxt-use-query/mutation': r('src/runtime/composables/useNuxtMutation.ts'),
  '@harlan-zw/nuxt-use-query/query': r('src/runtime/composables/useNuxtQuery.ts'),
  '@harlan-zw/nuxt-use-query/query-cache': r('src/runtime/composables/useQueryCache.ts'),
  '@harlan-zw/nuxt-use-query/rpc': r('src/runtime/rpc/index.ts'),
  '@harlan-zw/nuxt-use-query/subscription': r('src/runtime/composables/useNuxtSubscription.ts'),
  '@harlan-zw/nuxt-use-query/websocket': r('src/runtime/websocket.ts'),
  '@harlan-zw/nuxt-use-query/telemetry': r('src/runtime/telemetry.ts'),
}

const nuxtProject = defineVitestConfig({
  resolve: {
    alias: packageAliases,
  },
  test: {
    name: 'e2e',
    environment: 'nuxt',
    environmentOptions: {
      nuxt: {
        rootDir: r('test/fixture'),
      },
    },
    include: ['test/**/*.nuxt.test.ts'],
    globals: true,
  },
})

export default defineConfig({
  test: {
    globals: true,
    projects: [
      defineProject({
        resolve: {
          alias: {
            '#app': r('test/stubs/app.ts'),
            ...packageAliases,
          },
        },
        test: {
          name: 'unit',
          environment: 'happy-dom',
          include: ['test/**/*.test.ts', 'test/**/*.test-d.ts'],
          exclude: [
            '**/node_modules/**',
            'test/**/*.nuxt.test.ts',
          ],
          typecheck: {
            enabled: true,
            include: ['test/**/*.test-d.ts'],
          },
        },
      }),
      nuxtProject,
    ],
  },
})
