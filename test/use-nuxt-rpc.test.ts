import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const appFetch = vi.fn()

vi.mock('#app', () => ({
  useNuxtApp: () => ({ $fetch: appFetch, runWithContext: (fn: () => unknown) => fn() }),
}))

// Exposes the underlying error ref `useNuxtQuery` would own, so tests can drive
// what `useFetch` parks there and assert the `useNuxtRpcQuery` normalization.
const mocks = vi.hoisted(() => ({ queryError: undefined as { value: unknown } | undefined }))

vi.mock('../src/runtime/composables/useNuxtQuery', async () => {
  const { ref } = await import('vue')
  return {
    useNuxtQuery: vi.fn((_path, opts) => {
      mocks.queryError = ref(null)
      return { opts, error: mocks.queryError }
    }),
  }
})

const {
  createNuxtRpcClient,
  defineNuxtRpcMutation,
  defineNuxtRpcQuery,
  isAuthRpcError,
  isRetryableRpcError,
  normalizeNuxtRpcError,
  rpcErrorCategory,
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

  it('normalizes a raw HTTP FetchError parked in error.value into a NuxtRpcError', () => {
    const result = useNuxtRpcQuery(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
    })) as any

    // Simulate useFetch parking an ofetch FetchError after the request failed —
    // transform never ran, so without the wrapper this would be the raw error.
    mocks.queryError!.value = Object.assign(new Error('[GET] "/api/sites/1": 404'), {
      status: 404,
      response: { status: 404, statusText: 'Not Found' },
      data: { message: 'Missing' },
    })

    expect(result.error.value).toMatchObject({ type: 'fetch', status: 404, data: { message: 'Missing' } })
  })

  it('keeps error writable: clearing error.value writes through to the underlying ref', () => {
    const result = useNuxtRpcQuery(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
    })) as any

    mocks.queryError!.value = Object.assign(new Error('[GET] "/api/sites/1": 500'), {
      status: 500,
      response: { status: 500, statusText: 'Server Error' },
    })
    expect(result.error.value).toMatchObject({ type: 'fetch', status: 500 })

    // A consumer clearing the error directly must write through, not no-op.
    result.error.value = undefined
    expect(result.error.value).toBeUndefined()
    expect(mocks.queryError!.value).toBeUndefined()
  })

  it('leaves error.value undefined when the query has no error', () => {
    const result = useNuxtRpcQuery(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
    })) as any

    expect(result.error.value).toBeUndefined()
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

describe('useNuxtRpc safe variants (errors-as-values)', () => {
  it('querySafe returns an ok-tagged result on success without throwing', async () => {
    const fetch = vi.fn(async () => ({ id: 'abc' }))
    const rpc = createNuxtRpcClient({ fetch: fetch as any })

    const result = await rpc.querySafe(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
    }))

    expect(result).toEqual({ _tag: 'ok', data: { id: 'abc' } })
  })

  it('querySafe returns an err-tagged result carrying a typed NuxtRpcError', async () => {
    const fetchError = Object.assign(new Error('Not found'), {
      status: 404,
      data: { message: 'Missing' },
      response: { status: 404, statusText: 'Not Found' },
    })
    const onError = vi.fn()
    const rpc = createNuxtRpcClient({ fetch: (() => Promise.reject(fetchError)) as any, onError })

    const result = await rpc.querySafe(defineNuxtRpcQuery({
      key: 'missing',
      path: '/api/sites/missing',
      response: z.object({ id: z.string() }),
    }))

    expect(result._tag).toBe('err')
    if (result._tag === 'err') {
      expect(result.error).toMatchObject({ type: 'fetch', status: 404, data: { message: 'Missing' } })
    }
    expect(onError).toHaveBeenCalledOnce()
  })

  it('executeSafe returns an err-tagged result on request validation, without calling fetch', async () => {
    const fetch = vi.fn()
    const rpc = createNuxtRpcClient({ fetch: fetch as any })

    const result = await rpc.executeSafe(defineNuxtRpcMutation({
      body: z.object({ name: z.string() }),
      method: 'PATCH',
      path: '/api/sites/1',
      response: z.object({ ok: z.boolean() }),
    }), { name: 123 } as any)

    expect(result._tag).toBe('err')
    if (result._tag === 'err')
      expect(result.error).toMatchObject({ type: 'request-validation', issues: [{ path: 'name' }] })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('executeSafe returns an ok-tagged result and still fires success hooks', async () => {
    const onSuccess = vi.fn()
    const rpc = createNuxtRpcClient({ fetch: (async () => ({ ok: true })) as any, onSuccess })

    const result = await rpc.executeSafe(defineNuxtRpcMutation({
      body: null,
      method: 'POST',
      path: '/api/sites/1/refresh',
      response: z.object({ ok: z.boolean() }),
    }))

    expect(result).toEqual({ _tag: 'ok', data: { ok: true } })
    expect(onSuccess).toHaveBeenCalledOnce()
  })
})

describe('transient transport errors', () => {
  it('tags an ofetch timeout (cause.name === TimeoutError) as timeout', () => {
    const timeoutCause = Object.assign(new Error('aborted due to timeout'), { name: 'TimeoutError', code: 23 })
    const fetchError = Object.assign(new Error('[GET] "/x": <no response>'), { name: 'FetchError', cause: timeoutCause })

    const n = normalizeNuxtRpcError(fetchError)

    expect(n.type).toBe('timeout')
    expect(toHumanNuxtRpcError(n)).toMatch(/too long|try again/i)
  })

  it('tags a user/navigation abort (cause.name === AbortError) as aborted', () => {
    const abortCause = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const fetchError = Object.assign(new Error('[GET] "/x": <no response>'), { name: 'FetchError', cause: abortCause })

    expect(normalizeNuxtRpcError(fetchError).type).toBe('aborted')
  })

  it('tags a browser network failure (Failed to fetch, no response) as connection', () => {
    expect(normalizeNuxtRpcError(new TypeError('Failed to fetch')).type).toBe('connection')
  })

  it('tags a node undici failure (cause.code === ECONNREFUSED) as connection', () => {
    const e = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    })

    expect(normalizeNuxtRpcError(e).type).toBe('connection')
  })

  it('still tags a real HTTP error carrying a status as fetch, not transient', () => {
    const e = Object.assign(new Error('[GET] "/x": 500'), {
      status: 500,
      response: { status: 500, statusText: 'Server Error' },
    })

    expect(normalizeNuxtRpcError(e).type).toBe('fetch')
  })

  it('surfaces a timeout through querySafe as a typed err value', async () => {
    const timeoutCause = Object.assign(new Error('timeout'), { name: 'TimeoutError', code: 23 })
    const fetch = vi.fn(async () => {
      throw Object.assign(new Error('[GET] "/x": <no response>'), { name: 'FetchError', cause: timeoutCause })
    })
    const rpc = createNuxtRpcClient({ fetch: fetch as any })

    const result = await rpc.querySafe(defineNuxtRpcQuery({
      key: 'slow',
      path: '/api/slow',
      response: z.object({ id: z.string() }),
    }))

    expect(result._tag).toBe('err')
    if (result._tag === 'err')
      expect(result.error.type).toBe('timeout')
  })
})

describe('rpc hook isolation', () => {
  const httpReject = (status: number) => () =>
    Promise.reject(Object.assign(new Error(`[GET] "/p": ${status}`), { status, response: { status, statusText: 'x' } }))

  it('querySafe still resolves the err value when the onError hook throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rpc = createNuxtRpcClient({
      fetch: httpReject(500) as any,
      onError: () => { throw new Error('reporting hook blew up') },
    })

    const r = await rpc.querySafe(defineNuxtRpcQuery({ key: 'k', path: '/p', response: z.object({ id: z.string() }) }))

    expect(r._tag).toBe('err')
    if (r._tag === 'err')
      expect(r.error).toMatchObject({ type: 'fetch', status: 500 })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('executeSafe still resolves the err value when the onSettled hook rejects', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rpc = createNuxtRpcClient({
      fetch: httpReject(500) as any,
      onSettled: async () => { throw new Error('settle rejected') },
    })

    const r = await rpc.executeSafe(defineNuxtRpcMutation({ body: null, method: 'POST', path: '/p', response: z.object({ ok: z.boolean() }) }))

    expect(r._tag).toBe('err')
    spy.mockRestore()
  })

  it('a throwing onSuccess does not flip a successful querySafe to err, nor fire onError', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onError = vi.fn()
    const rpc = createNuxtRpcClient({
      fetch: (async () => ({ id: 'abc' })) as any,
      onSuccess: () => { throw new Error('success hook blew up') },
      onError,
    })

    const r = await rpc.querySafe(defineNuxtRpcQuery({ key: 'k', path: '/p', response: z.object({ id: z.string() }) }))

    expect(r).toEqual({ _tag: 'ok', data: { id: 'abc' } })
    expect(onError).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('the throwing query() variant rejects with the RPC error, not the hook error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rpc = createNuxtRpcClient({
      fetch: httpReject(404) as any,
      onError: () => { throw new Error('hook noise') },
    })

    await expect(rpc.query(defineNuxtRpcQuery({ key: 'k', path: '/p', response: z.object({ id: z.string() }) })))
      .rejects
      .toMatchObject({ type: 'fetch', status: 404 })
    spy.mockRestore()
  })
})

describe('rpc error predicates', () => {
  const httpError = (status: number) =>
    normalizeNuxtRpcError(Object.assign(new Error('x'), { status, response: { status, statusText: 'x' } }))
  const timeout = normalizeNuxtRpcError(Object.assign(new Error('t'), { name: 'TimeoutError', code: 23 }))
  const connection = normalizeNuxtRpcError(new TypeError('Failed to fetch'))
  const aborted = normalizeNuxtRpcError(Object.assign(new Error('a'), { name: 'AbortError' }))
  const validation = normalizeNuxtRpcError(z.object({ a: z.string() }).safeParse({}).error!, 'request-validation')

  it('isRetryableRpcError: timeout/connection/5xx/429 retry, abort/4xx/validation do not', () => {
    expect(isRetryableRpcError(timeout)).toBe(true)
    expect(isRetryableRpcError(connection)).toBe(true)
    expect(isRetryableRpcError(httpError(503))).toBe(true)
    expect(isRetryableRpcError(httpError(429))).toBe(true)
    expect(isRetryableRpcError(aborted)).toBe(false)
    expect(isRetryableRpcError(httpError(404))).toBe(false)
    expect(isRetryableRpcError(validation)).toBe(false)
  })

  it('isAuthRpcError: only 401/403', () => {
    expect(isAuthRpcError(httpError(401))).toBe(true)
    expect(isAuthRpcError(httpError(403))).toBe(true)
    expect(isAuthRpcError(httpError(404))).toBe(false)
    expect(isAuthRpcError(timeout)).toBe(false)
  })

  it('rpcErrorCategory: projects every tag onto a coarse axis', () => {
    expect(rpcErrorCategory(timeout)).toBe('transient')
    expect(rpcErrorCategory(connection)).toBe('transient')
    expect(rpcErrorCategory(aborted)).toBe('transient')
    expect(rpcErrorCategory(validation)).toBe('validation')
    expect(rpcErrorCategory(httpError(401))).toBe('auth')
    expect(rpcErrorCategory(httpError(404))).toBe('client')
    expect(rpcErrorCategory(httpError(500))).toBe('server')
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
