import { describe, expect, it } from 'vitest'

describe('subpath exports', () => {
  it('loads direct runtime entrypoints', async () => {
    const query = await import('nuxt-use-query/query')
    const mutation = await import('nuxt-use-query/mutation')
    const rpc = await import('nuxt-use-query/rpc')
    const queryCache = await import('nuxt-use-query/query-cache')
    const cache = await import('nuxt-use-query/cache')

    expect(query.useNuxtQuery).toBeTypeOf('function')
    expect(mutation.useNuxtMutation).toBeTypeOf('function')
    expect(rpc.defineNuxtRpcQuery).toBeTypeOf('function')
    expect(rpc.createNuxtRpcClient).toBeTypeOf('function')
    expect(queryCache.invalidateNuxtQueries).toBeTypeOf('function')
    expect(cache.createQueryCache).toBeTypeOf('function')
  })
})
