import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const appFetch = vi.fn()

vi.mock('#app', () => ({
  useNuxtApp: () => ({ $fetch: appFetch }),
}))

vi.mock('../src/runtime/composables/useNuxtQuery', () => ({
  useNuxtQuery: vi.fn((_path, opts) => ({ opts })),
}))

const {
  createNuxtRpcClient,
  defineNuxtRpcMutation,
  defineNuxtRpcQuery,
  serializeNuxtRpcKey,
  useNuxtRpc,
  useNuxtRpcQuery,
} = await import('nuxt-use-query/rpc')

describe('defineNuxtRpcQuery', () => {
  it('preserves operation contracts for query consumers', () => {
    const operation = defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
    })

    expect(operation.key).toBe('site:1')
    expect(operation.path).toBe('/api/sites/1')
  })
})

describe('serializeNuxtRpcKey', () => {
  it('keeps string keys and serializes tuple keys', () => {
    expect(serializeNuxtRpcKey('sites:1')).toBe('sites:1')
    expect(serializeNuxtRpcKey(['sites', 'abc/123', 7])).toBe('sites:abc%2F123:7')
  })
})

describe('useNuxtRpcQuery', () => {
  it('passes key/query options through and parses responses with the operation schema', () => {
    const operation = defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      query: { period: 'week' },
      response: z.object({ id: z.string() }),
    })

    const result = useNuxtRpcQuery(operation, { server: false }) as any

    expect(result.opts.key()).toBe('site:1')
    expect(result.opts.query.value).toEqual({ period: 'week' })
    expect(result.opts.transform({ id: 'abc' })).toEqual({ id: 'abc' })
    expect(() => result.opts.transform({ id: 123 })).toThrow()
  })
})

describe('useNuxtRpc', () => {
  it('creates a fetch-backed client without a Nuxt app dependency', async () => {
    const fetch = vi.fn(async () => ({ id: 'abc' }))
    const rpc = createNuxtRpcClient({ fetch: fetch as any })

    const result = await rpc.query(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
    }))

    expect(fetch).toHaveBeenCalledWith('/api/sites/1', {})
    expect(result).toEqual({ id: 'abc' })
  })

  it('queries with the injected fetch and parses the response schema', async () => {
    const fetch = vi.fn(async () => ({ id: 'abc' }))
    const rpc = useNuxtRpc({ fetch: fetch as any })

    const result = await rpc.query(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      query: { period: 'week' },
      response: z.object({ id: z.string() }),
    }))

    expect(fetch).toHaveBeenCalledWith('/api/sites/1', { query: { period: 'week' } })
    expect(result).toEqual({ id: 'abc' })
  })

  it('parses mutation bodies before fetching and parses mutation responses', async () => {
    const fetch = vi.fn(async () => ({ ok: true }))
    const rpc = useNuxtRpc({ fetch: fetch as any })

    const result = await rpc.execute(defineNuxtRpcMutation({
      body: z.object({ name: z.string().trim() }),
      method: 'PATCH',
      path: '/api/sites/1',
      response: z.object({ ok: z.boolean() }),
    }), { name: ' Example ' })

    expect(fetch).toHaveBeenCalledWith('/api/sites/1', {
      method: 'PATCH',
      body: { name: 'Example' },
    })
    expect(result).toEqual({ ok: true })
  })

  it('allows explicit bodyless POST mutations with body: null', async () => {
    const fetch = vi.fn(async () => ({ ok: true }))
    const rpc = useNuxtRpc({ fetch: fetch as any })

    const result = await rpc.execute(defineNuxtRpcMutation({
      body: null,
      method: 'POST',
      path: '/api/sites/1/refresh',
      response: z.object({ ok: z.boolean() }),
    }))

    expect(fetch).toHaveBeenCalledWith('/api/sites/1/refresh', {
      method: 'POST',
    })
    expect(result).toEqual({ ok: true })
  })

  it('rejects invalid mutation bodies before calling fetch', async () => {
    const fetch = vi.fn()
    const rpc = useNuxtRpc({ fetch: fetch as any })

    await expect(rpc.execute(defineNuxtRpcMutation({
      body: z.object({ name: z.string() }),
      method: 'PATCH',
      path: '/api/sites/1',
      response: z.object({ ok: z.boolean() }),
    }), { name: 123 } as any)).rejects.toThrow()

    expect(fetch).not.toHaveBeenCalled()
  })
})
