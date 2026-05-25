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
  normalizeNuxtRpcError,
  serializeNuxtRpcKey,
  toHumanNuxtRpcError,
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

  it('normalizes request validation errors and notifies the error hook', async () => {
    const fetch = vi.fn()
    const onError = vi.fn()
    const rpc = useNuxtRpc({ fetch: fetch as any, onError })

    await expect(rpc.execute(defineNuxtRpcMutation({
      body: z.object({ name: z.string() }),
      method: 'PATCH',
      path: '/api/sites/1',
      response: z.object({ ok: z.boolean() }),
    }), { name: 123 } as any)).rejects.toMatchObject({
      type: 'request-validation',
      issues: [{ path: 'name' }],
    })

    expect(fetch).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      operation: expect.objectContaining({ kind: 'mutation', method: 'PATCH', path: '/api/sites/1' }),
      error: expect.objectContaining({ type: 'request-validation' }),
    }))
  })

  it('normalizes response validation errors', async () => {
    const fetch = vi.fn(async () => ({ ok: 'yes' }))
    const rpc = useNuxtRpc({ fetch: fetch as any })

    await expect(rpc.execute(defineNuxtRpcMutation({
      body: null,
      method: 'POST',
      path: '/api/sites/1/refresh',
      response: z.object({ ok: z.boolean() }),
    }))).rejects.toMatchObject({
      type: 'response-validation',
      issues: [{ path: 'ok' }],
    })
  })

  it('normalizes fetch errors with status and response data', async () => {
    const fetchError = Object.assign(new Error('Not found'), {
      status: 404,
      data: { message: 'Missing' },
      response: { status: 404, statusText: 'Not Found' },
    })
    const fetch = vi.fn(async () => {
      throw fetchError
    })
    const onError = vi.fn()
    const rpc = useNuxtRpc({ fetch: fetch as any, onError })

    await expect(rpc.query(defineNuxtRpcQuery({
      key: 'missing',
      path: '/api/sites/missing',
      response: z.object({ id: z.string() }),
    }))).rejects.toMatchObject({
      type: 'fetch',
      status: 404,
      data: { message: 'Missing' },
    })

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      operation: expect.objectContaining({ kind: 'query', method: 'GET', path: '/api/sites/missing' }),
      error: expect.objectContaining({ type: 'fetch', status: 404 }),
    }))
  })

  it('supports success, settled, and silent error hooks', async () => {
    const onSuccess = vi.fn()
    const onSettled = vi.fn()
    const onError = vi.fn()
    const rpc = useNuxtRpc({
      fetch: vi.fn(async () => ({ id: 'abc' })) as any,
      onError,
      onSettled,
      onSuccess,
    })

    await rpc.query(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
    }))

    expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({
      data: { id: 'abc' },
      operation: expect.objectContaining({ key: 'site:1' }),
    }))
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ data: { id: 'abc' } }))

    const failing = useNuxtRpc({
      fetch: vi.fn(async () => {
        throw Object.assign(new Error('Nope'), { status: 500 })
      }) as any,
      onError,
      onSettled,
    })
    await expect(failing.query(defineNuxtRpcQuery({
      key: 'site:2',
      path: '/api/sites/2',
      response: z.object({ id: z.string() }),
    }), { silent: true })).rejects.toMatchObject({ type: 'fetch', status: 500 })

    expect(onError).not.toHaveBeenCalled()
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ type: 'fetch', status: 500 }),
    }))
  })
})

describe('rpc error helpers', () => {
  it('formats Zod issues and maps common HTTP statuses to human copy', () => {
    const zodError = z.object({ email: z.string().email() }).safeParse({ email: 'nope' })
    expect(zodError.success).toBe(false)
    if (!zodError.success) {
      const normalized = normalizeNuxtRpcError(zodError.error, 'request-validation')
      expect(normalized).toMatchObject({
        type: 'request-validation',
        issues: [{ path: 'email' }],
      })
      expect(toHumanNuxtRpcError(normalized)).toContain('email')
    }

    expect(toHumanNuxtRpcError({ type: 'fetch', status: 404, message: 'x', cause: new Error('x') }))
      .toBe('We could not find that resource.')
  })
})
