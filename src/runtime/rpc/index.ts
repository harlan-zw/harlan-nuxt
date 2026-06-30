// Public subpath surface for `nuxt-use-query/rpc`. Re-exports the RPC core
// (operation types, define helpers, client factory, error normalization) and
// the two RPC composables. Keeping the surface here means the composable file
// stays a composable file and `module.ts` can point `addImports` directly at
// the source of each symbol.

export {
  invalidateNuxtRpc,
  useNuxtRpc,
  useNuxtRpcQuery,
} from '../composables/useNuxtRpc'
export type {
  UseNuxtRpcOptions,
  UseNuxtRpcQueryOptions,
} from '../composables/useNuxtRpc'
export * from './core'
