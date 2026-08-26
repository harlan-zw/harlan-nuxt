import type { ContractQueryEnforcementOptions } from './enforcement'
import type { ModuleRuntimeConfig, ModuleTelemetryOptions } from './module/telemetry'
import { addImports, addPlugin, addTypeTemplate, createResolver, defineNuxtModule } from '@nuxt/kit'
import { setupFetchTelemetryModule } from './module/telemetry'

// `nuxt-use-query` — TanStack-Query-shaped wrapper over Nuxt's `useFetch` /
// `useAsyncData`. Built on Nuxt primitives (refreshNuxtData, clearNuxtData,
// `_asyncData`); cache state lives on the Nuxt app instance for SSR safety.
//
// Exposes auto-imports: useNuxtQuery, useNuxtAsyncQuery, useNuxtMutation,
// useNuxtRpc, useNuxtRpcQuery, useNuxtSubscription, nuxtWebSocketSource,
// useQueryCache, invalidateNuxtQueries, invalidateNuxtRpc, removeNuxtQueries,
// getQueryData, setQueryData, defineNuxtQueryGroup, defineNuxtRpcQuery,
// defineNuxtRpcMutation, defineNuxtRpcSchemaGroup, serializeNuxtRpcKey.

export interface ModuleOptions {
  /**
   * Enforce the shared/contracts + app/queries operation pattern at build time.
   * When enabled, API path literals must live in configured query dirs and
   * query files must define Zod-backed Nuxt RPC operations.
   */
  contracts?: ContractQueryEnforcementOptions
  /**
   * Server-side `$fetch` telemetry and default timeout. Enable with `true` to
   * log slow fetches, timeouts, and likely SSR waterfalls, or pass an object to
   * tune thresholds and console output.
   */
  telemetry?: ModuleTelemetryOptions
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@harlan-zw/nuxt-use-query',
    configKey: 'nuxtUseQuery',
    compatibility: { nuxt: '>=4.5.0 <6.0.0' },
  },
  defaults: {
    contracts: {
      enabled: false,
    },
    telemetry: false,
  },
  setup(options, nuxt) {
    const resolver = createResolver(import.meta.url)

    const composables = resolver.resolve('./runtime/composables')
    const rpcCore = resolver.resolve('./runtime/rpc/core')
    const websocket = resolver.resolve('./runtime/websocket')

    addImports([
      { name: 'useNuxtQuery', from: `${composables}/useNuxtQuery` },
      { name: 'useNuxtAsyncQuery', from: `${composables}/useNuxtAsyncQuery` },
      { name: 'useNuxtMutation', from: `${composables}/useNuxtMutation` },
      { name: 'useNuxtRpc', from: `${composables}/useNuxtRpc` },
      { name: 'useNuxtRpcQuery', from: `${composables}/useNuxtRpc` },
      { name: 'invalidateNuxtRpc', from: `${composables}/useNuxtRpc` },
      { name: 'useNuxtSubscription', from: `${composables}/useNuxtSubscription` },
      { name: 'nuxtWebSocketSource', from: websocket },
      { name: 'useQueryCache', from: `${composables}/useQueryCache` },
      { name: 'invalidateNuxtQueries', from: `${composables}/useQueryCache` },
      { name: 'removeNuxtQueries', from: `${composables}/useQueryCache` },
      { name: 'getQueryData', from: `${composables}/useQueryCache` },
      { name: 'setQueryData', from: `${composables}/useQueryCache` },
      { name: 'defineNuxtQueryGroup', from: rpcCore },
      { name: 'defineNuxtRpcMutation', from: rpcCore },
      { name: 'defineNuxtRpcQuery', from: rpcCore },
      { name: 'defineNuxtRpcSchemaGroup', from: rpcCore },
      { name: 'serializeNuxtRpcKey', from: rpcCore },
    ])

    // A generated template participates in the consuming Nuxt project's
    // `#app` alias resolution. Keep the public `nuxt/app` augmentation too for
    // layers that import Nuxt runtime APIs explicitly.
    addTypeTemplate({
      filename: 'types/nuxt-use-query.d.ts',
      getContents: () => `
import type { NuxtUseQueryRuntimeNuxtHooks } from '@harlan-zw/nuxt-use-query/telemetry'

declare module '#app' {
  interface RuntimeNuxtHooks extends NuxtUseQueryRuntimeNuxtHooks {}
}

declare module 'nuxt/app' {
  interface RuntimeNuxtHooks extends NuxtUseQueryRuntimeNuxtHooks {}
}

export {}
`,
    })

    // Server-only: serializes the per-request `lastFetched` map into the
    // payload so the client seeds exact fetch timestamps.
    addPlugin({ mode: 'server', src: resolver.resolve('./runtime/plugin.server') })

    // Both runtimes: the reducer runs on the server, the reviver on the
    // client, so a `NuxtRpcError` survives the payload with its tag.
    addPlugin({ src: resolver.resolve('./runtime/plugin-rpc-payload') })

    setupFetchTelemetryModule(
      options.telemetry,
      nuxt.options.runtimeConfig as ModuleRuntimeConfig,
      resolver.resolve('./runtime/server/plugins/fetch-telemetry'),
    )

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
