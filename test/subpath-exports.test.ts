import { describe, expect, it } from 'vitest'

describe('subpath exports', () => {
  it('loads direct runtime entrypoints', async () => {
    const query = await import('nuxt-use-query/query')
    const mutation = await import('nuxt-use-query/mutation')
    const rpc = await import('nuxt-use-query/rpc')
    const telemetry = await import('nuxt-use-query/telemetry')
    const queryCache = await import('nuxt-use-query/query-cache')
    const cache = await import('nuxt-use-query/cache')

    expect(query.useNuxtQuery).toBeTypeOf('function')
    expect(mutation.useNuxtMutation).toBeTypeOf('function')
    expect(rpc.defineNuxtRpcQuery).toBeTypeOf('function')
    expect(rpc.createNuxtRpcClient).toBeTypeOf('function')
    expect(telemetry.NUXT_USE_QUERY_TELEMETRY_HOOKS.queryFinish).toBe('nuxt-use-query:telemetry:query:finish')
    expect(queryCache.invalidateNuxtQueries).toBeTypeOf('function')
    expect('seedCacheFromPayload' in queryCache).toBe(false)
    expect('serializeQueryCacheToPayload' in queryCache).toBe(false)
    expect(cache.createQueryCache).toBeTypeOf('function')
  })
})
