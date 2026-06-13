import type { ContractQueryEnforcementOptions } from './enforcement'
import { addImports, addPlugin, createResolver, defineNuxtModule } from '@nuxt/kit'

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

    const composables = resolver.resolve('./runtime/composables')
    const rpcCore = resolver.resolve('./runtime/rpc/core')

    addImports([
      { name: 'useNuxtQuery', from: `${composables}/useNuxtQuery` },
      { name: 'useNuxtMutation', from: `${composables}/useNuxtMutation` },
      { name: 'useNuxtRpc', from: `${composables}/useNuxtRpc` },
      { name: 'useNuxtRpcQuery', from: `${composables}/useNuxtRpc` },
      { name: 'useQueryCache', from: `${composables}/useQueryCache` },
      { name: 'invalidateNuxtQueries', from: `${composables}/useQueryCache` },
      { name: 'getQueryData', from: `${composables}/useQueryCache` },
      { name: 'setQueryData', from: `${composables}/useQueryCache` },
      { name: 'defineNuxtQueryGroup', from: rpcCore },
      { name: 'defineNuxtRpcMutation', from: rpcCore },
      { name: 'defineNuxtRpcQuery', from: rpcCore },
      { name: 'serializeNuxtRpcKey', from: rpcCore },
    ])

    // Serializes the per-request `lastFetched` map into the payload so the
    // client seeds exact fetch timestamps (see runtime/plugin.ts).
    addPlugin(resolver.resolve('./runtime/plugin'))

    if (options.contracts?.enabled) {
      nuxt.hook('build:before', async () => {
        const {
          formatContractQueryViolations,
          scanContractQueryViolations,
        } = await import('./enforcement')
        const violations = await scanContractQueryViolations(nuxt.options.rootDir, options.contracts)
        if (!violations.length)
          return
        const message = formatContractQueryViolations(violations)
        if (options.contracts?.severity === 'warn') {
          const { consola } = await import('consola')
          consola.withTag('nuxt-use-query').warn(message)
          return
        }
        throw new Error(message)
      })
    }
  },
})
