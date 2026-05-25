import type { ContractQueryEnforcementOptions } from './enforcement'
import { addImports, createResolver, defineNuxtModule } from '@nuxt/kit'

// `nuxt-use-query` — TanStack-Query-shaped wrapper over Nuxt's `useFetch` /
// `useAsyncData`. Built on Nuxt primitives (refreshNuxtData, clearNuxtData,
// `_asyncData`); cache state lives on the Nuxt app instance for SSR safety.
//
// Exposes auto-imports: useNuxtQuery, useNuxtMutation, useNuxtRpc,
// useNuxtRpcQuery, useQueryCache, invalidateNuxtQueries, getQueryData,
// setQueryData.

export interface ModuleOptions {
  /**
   * Enforce the shared/contracts + app/queries operation pattern at build time.
   * When enabled, API path literals must live in configured query dirs and
   * query files must define Zod-backed Nuxt RPC operations.
   */
  contracts?: ContractQueryEnforcementOptions
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'nuxt-use-query',
    configKey: 'nuxtUseQuery',
  },
  defaults: {
    contracts: {
      enabled: false,
    },
  },
  setup(options, nuxt) {
    const resolver = createResolver(import.meta.url)
    const runtimeDir = resolver.resolve('./runtime')

    nuxt.options.alias['#nuxt-use-query'] = runtimeDir
    nuxt.options.alias['#nuxt-query'] = runtimeDir

    addImports([
      { name: 'useNuxtQuery', from: resolver.resolve('./runtime/composables/useNuxtQuery') },
      { name: 'useNuxtMutation', from: resolver.resolve('./runtime/composables/useNuxtMutation') },
      { name: 'defineNuxtQueryGroup', from: resolver.resolve('./runtime/composables/useNuxtRpc') },
      { name: 'defineNuxtRpcMutation', from: resolver.resolve('./runtime/composables/useNuxtRpc') },
      { name: 'defineNuxtRpcQuery', from: resolver.resolve('./runtime/composables/useNuxtRpc') },
      { name: 'serializeNuxtRpcKey', from: resolver.resolve('./runtime/composables/useNuxtRpc') },
      { name: 'useNuxtRpc', from: resolver.resolve('./runtime/composables/useNuxtRpc') },
      { name: 'useNuxtRpcQuery', from: resolver.resolve('./runtime/composables/useNuxtRpc') },
      { name: 'useQueryCache', from: resolver.resolve('./runtime/composables/useQueryCache') },
      { name: 'invalidateNuxtQueries', from: resolver.resolve('./runtime/composables/useQueryCache') },
      { name: 'getQueryData', from: resolver.resolve('./runtime/composables/useQueryCache') },
      { name: 'setQueryData', from: resolver.resolve('./runtime/composables/useQueryCache') },
    ])

    if (options.contracts?.enabled) {
      nuxt.hook('build:before', async () => {
        const {
          formatContractQueryViolations,
          scanContractQueryViolations,
        } = await import('./enforcement')
        const violations = await scanContractQueryViolations(nuxt.options.rootDir, options.contracts)
        if (violations.length)
          throw new Error(formatContractQueryViolations(violations))
      })
    }
  },
})
