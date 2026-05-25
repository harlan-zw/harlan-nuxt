import { defineVitestConfig } from '@nuxt/test-utils/config'
import { defineConfig, defineProject } from 'vitest/config'

const packageAliases = {
  'nuxt-use-query/cache': '/home/harlan/pkg/nuxt-use-query/src/runtime/cache.ts',
  'nuxt-use-query/mutation': '/home/harlan/pkg/nuxt-use-query/src/runtime/composables/useNuxtMutation.ts',
  'nuxt-use-query/query': '/home/harlan/pkg/nuxt-use-query/src/runtime/composables/useNuxtQuery.ts',
  'nuxt-use-query/query-cache': '/home/harlan/pkg/nuxt-use-query/src/runtime/composables/useQueryCache.ts',
  'nuxt-use-query/rpc': '/home/harlan/pkg/nuxt-use-query/src/runtime/rpc/index.ts',
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
        rootDir: '/home/harlan/pkg/nuxt-use-query/test/fixture',
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
            '#app': '/home/harlan/pkg/nuxt-use-query/test/stubs/app.ts',
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
