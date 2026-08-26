import { describe, expect, it, vi } from 'vitest'
import { shallowRef } from 'vue'
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
  defineNuxtRpcSchemaGroup,
  isAuthRpcError,
  isRetryableRpcError,
  normalizeNuxtRpcError,
  rpcErrorCategory,
  serializeNuxtRpcKey,
  toHumanNuxtRpcError,
  useNuxtRpc,
  useNuxtRpcQuery,
} = await import('@harlan-zw/nuxt-use-query/rpc')
const {
  serializeCanonicalJson,
  serializeNuxtRpcQueryKey,
} = await import('../src/runtime/rpc/core')

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

describe('defineNuxtRpcSchemaGroup', () => {
  it('loads one schema module once and parses every selected schema', async () => {
    const load = vi.fn(async () => ({
      mutationBody: z.object({ name: z.string().trim() }),
      mutationResponse: z.object({ ok: z.boolean() }),
      queryResponse: z.object({ id: z.string() }),
    }))
    const schemas = defineNuxtRpcSchemaGroup(load)
    const fetch = vi.fn()
      .mockResolvedValueOnce({ id: 'abc' })
      .mockResolvedValueOnce({ ok: true })
    const rpc = createNuxtRpcClient({ fetch: fetch as any })

    await expect(rpc.query(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: schemas('queryResponse'),
    }))).resolves.toEqual({ id: 'abc' })
    await expect(rpc.execute(defineNuxtRpcMutation({
      body: schemas('mutationBody'),
      method: 'PATCH',
      path: '/api/sites/1',
      response: schemas('mutationResponse'),
    }), { name: ' Example ' })).resolves.toEqual({ ok: true })

    expect(fetch).toHaveBeenLastCalledWith('/api/sites/1', {
      method: 'PATCH',
      body: { name: 'Example' },
    })
    expect(load).toHaveBeenCalledOnce()
  })

  it('waits for the schema and never returns an unparsed response', async () => {
    let resolveSchema!: (value: { response: z.ZodTypeAny }) => void
    const schemas = defineNuxtRpcSchemaGroup(() => new Promise(resolve => void (resolveSchema = resolve)))
    const rpc = createNuxtRpcClient({ fetch: (async () => ({ id: 123 })) as any })
    const pending = rpc.querySafe(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: schemas('response'),
    }))
    let settled = false
    void pending.then(() => void (settled = true))

    await Promise.resolve()
    expect(settled).toBe(false)
    resolveSchema({ response: z.object({ id: z.string() }) })

    await expect(pending).resolves.toMatchObject({
      _tag: 'err',
      error: { type: 'response-validation' },
    })
  })

  it('tags a schema load failure and retries the module on the next call', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockResolvedValueOnce({ response: z.object({ id: z.string() }) })
    const schemas = defineNuxtRpcSchemaGroup(load)
    const rpc = createNuxtRpcClient({ fetch: (async () => ({ id: 'abc' })) as any })
    const operation = defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: schemas('response'),
    })

    await expect(rpc.querySafe(operation)).resolves.toMatchObject({
      _tag: 'err',
      error: { phase: 'response', type: 'schema-load' },
    })
    await expect(rpc.query(operation)).resolves.toEqual({ id: 'abc' })
    expect(load).toHaveBeenCalledTimes(2)
  })
})

describe('serializeNuxtRpcKey', () => {
  it('keeps string keys and serializes tuple keys', () => {
    expect(serializeNuxtRpcKey('sites:1')).toBe('sites:1')
    expect(serializeNuxtRpcKey(['sites', 'abc/123', 7])).toBe('sites:abc%2F123:%24number%3A7')
  })

  it('does not collide across key-part types or object values', () => {
    expect(serializeNuxtRpcKey(['sites', 1])).not.toBe(serializeNuxtRpcKey(['sites', '1']))
    expect(serializeNuxtRpcKey(['sites', true])).not.toBe(serializeNuxtRpcKey(['sites', 'true']))
    expect(serializeNuxtRpcKey(['sites', { page: 1 }])).not.toBe(serializeNuxtRpcKey(['sites', { page: 2 }]))
    expect(serializeNuxtRpcKey(['sites', { page: 1, sort: 'asc' }]))
      .toBe(serializeNuxtRpcKey(['sites', { sort: 'asc', page: 1 }]))
  })

  it('canonicalizes plain JSON objects independently of insertion order', () => {
    expect(serializeCanonicalJson({ z: 1, a: { y: 2, x: 1 } }))
      .toBe('{"a":{"x":1,"y":2},"z":1}')
  })

  it('rejects sparse arrays instead of aliasing their `[null]` wire body to `[]`', () => {
    const sparse: unknown[] = []
    sparse.length = 1
    expect(JSON.stringify(sparse)).toBe('[null]')
    expect(() => serializeCanonicalJson(sparse)).toThrow(/cannot be sparse/)
    expect(serializeCanonicalJson([])).toBe('[]')
  })

  it('rejects stateful JSON hooks/accessors that could change between keying and transport serialization', () => {
    const withToJson = [1] as number[] & { toJSON?: () => number[] }
    withToJson.toJSON = () => [2]
    expect(() => serializeCanonicalJson(withToJson)).toThrow(/cannot define toJSON/)

    const withGetter: Record<string, unknown> = {}
    Object.defineProperty(withGetter, 'value', {
      enumerable: true,
      get: () => Math.random(),
    })
    expect(() => serializeCanonicalJson(withGetter)).toThrow(/cannot contain accessors/)
  })

  it('includes the parsed POST body in the exact query key', () => {
    const schema = z.object({ term: z.string().trim(), limit: z.number().default(10) })
    const first = defineNuxtRpcQuery({
      key: ['search', 'sites'],
      method: 'POST',
      idempotent: true,
      path: '/api/search',
      body: { schema, value: { limit: 10, term: ' docs ' } },
      response: z.array(z.string()),
    })
    const equivalent = defineNuxtRpcQuery({
      key: ['search', 'sites'],
      method: 'POST',
      idempotent: true,
      path: '/api/search',
      body: { schema, value: { term: 'docs', limit: 10 } },
      response: z.array(z.string()),
    })
    const different = defineNuxtRpcQuery({
      key: ['search', 'sites'],
      method: 'POST',
      idempotent: true,
      path: '/api/search',
      body: { schema, value: { term: 'other', limit: 10 } },
      response: z.array(z.string()),
    })

    expect(serializeNuxtRpcQueryKey(first)).toBe(serializeNuxtRpcQueryKey(equivalent))
    expect(serializeNuxtRpcQueryKey(first)).not.toBe(serializeNuxtRpcQueryKey(different))
    expect(serializeNuxtRpcQueryKey(first)).toContain('%24body')
    expect(serializeNuxtRpcQueryKey(first)).toContain(encodeURIComponent('{"limit":10,"term":"docs"}'))
  })
})

describe('useNuxtRpcQuery', () => {
  it('awaits a deferred response schema in the query transform', async () => {
    const schemas = defineNuxtRpcSchemaGroup(async () => ({
      response: z.object({ id: z.string() }),
    }))
    const result = useNuxtRpcQuery(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: schemas('response'),
    })) as any

    await expect(result.opts.transform({ id: 'abc' })).resolves.toEqual({ id: 'abc' })
    await expect(result.opts.transform({ id: 123 })).rejects.toMatchObject({ type: 'response-validation' })
  })

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

  it('validates a reactive POST body once and uses its parsed output for key and request', () => {
    const parse = vi.fn((value: unknown) => value)
    const schema = z.preprocess(parse, z.object({ term: z.string().trim() }))
    const raw = { term: ' docs ', ignored: true }
    const result = useNuxtRpcQuery(defineNuxtRpcQuery({
      key: 'search',
      method: 'POST',
      idempotent: true,
      path: '/api/search',
      query: { locale: 'en' },
      body: { schema, value: raw },
      response: z.array(z.string()),
    })) as any

    expect(result.opts.key()).toContain(encodeURIComponent('{"term":"docs"}'))
    expect(result.opts.method.value).toBe('POST')
    expect(result.opts.body.value).toEqual({ term: 'docs' })
    expect(result.opts.query.value).toEqual({ locale: 'en' })
    expect(parse).toHaveBeenCalledTimes(1)
  })

  it('re-resolves the POST body and cache key when the operation changes', () => {
    const schema = z.object({ term: z.string().trim() })
    const operation = shallowRef(defineNuxtRpcQuery({
      key: 'reactive-search',
      method: 'POST',
      idempotent: true,
      path: '/api/search',
      body: { schema, value: { term: ' first ' } },
      response: z.array(z.string()),
    }))
    const result = useNuxtRpcQuery(operation) as any
    const firstKey = result.opts.key()
    expect(result.opts.body.value).toEqual({ term: 'first' })

    operation.value = defineNuxtRpcQuery({
      key: 'reactive-search',
      method: 'POST',
      idempotent: true,
      path: '/api/search',
      body: { schema, value: { term: ' second ' } },
      response: z.array(z.string()),
    })

    expect(result.opts.body.value).toEqual({ term: 'second' })
    expect(result.opts.key()).not.toBe(firstKey)
  })

  it('parks declarative POST request validation at a deterministic invalid key', () => {
    const operation = defineNuxtRpcQuery({
      key: 'search',
      method: 'POST',
      idempotent: true,
      path: '/api/search',
      body: { schema: z.object({ term: z.string() }), value: { term: 123 } as any },
      response: z.array(z.string()),
    })
    const result = useNuxtRpcQuery(operation) as any

    expect(result.opts.key()).toContain('%24invalid-body')
    expect(result.opts.method.value).toBe('POST')
    expect(result.opts.body.value).toBeUndefined()
    expect(() => result.opts.onRequest[0]()).toThrow(expect.objectContaining({
      type: 'request-validation',
      issues: [expect.objectContaining({ path: 'term' })],
    }))
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

  it('sends the parsed body for an idempotent POST query', async () => {
    const fetch = vi.fn(async () => ({ ids: ['1'] }))
    const parse = vi.fn((value: unknown) => value)
    const rpc = useNuxtRpc({ fetch: fetch as any })

    const result = await rpc.query(defineNuxtRpcQuery({
      key: 'site-search',
      method: 'POST',
      idempotent: true,
      path: '/api/sites/search',
      query: { locale: 'en' },
      body: {
        schema: z.preprocess(parse, z.object({ term: z.string().trim() })),
        value: { term: ' docs ', ignored: true },
      },
      response: z.object({ ids: z.array(z.string()) }),
    }))

    expect(fetch).toHaveBeenCalledWith('/api/sites/search', {
      method: 'POST',
      query: { locale: 'en' },
      body: { term: 'docs' },
    })
    expect(parse).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ ids: ['1'] })
  })

  it('rejects an invalid POST query body before fetching', async () => {
    const fetch = vi.fn()
    const rpc = useNuxtRpc({ fetch: fetch as any })

    await expect(rpc.query(defineNuxtRpcQuery({
      key: 'site-search',
      method: 'POST',
      idempotent: true,
      path: '/api/sites/search',
      body: { schema: z.object({ term: z.string() }), value: { term: 123 } as any },
      response: z.object({ ids: z.array(z.string()) }),
    }))).rejects.toMatchObject({
      type: 'request-validation',
      issues: [{ path: 'term' }],
    })
    expect(fetch).not.toHaveBeenCalled()
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

// A schema slot exposing only `parse` (no `safeParse`) — mirrors a deferred or
// boot-time-loaded schema wrapper in app code. Calling `.safeParse()`
// unconditionally on a slot like this is exactly what broke prod
// ("e.safeParse is not a function"); lenient mode must fall back to a
// try/catch around `.parse()` instead.
function parseOnlySchema<T>(schema: z.ZodType<T>): z.ZodType<T> {
  return { parse: (input: unknown) => schema.parse(input) } as unknown as z.ZodType<T>
}

describe('lenient response validation', () => {
  it('querySafe recovers a lenient mismatch: returns the raw payload and fires onError with recovered:true', async () => {
    const onError = vi.fn()
    const onSuccess = vi.fn()
    const rpc = createNuxtRpcClient({ fetch: (async () => ({ id: 123 })) as any, onError, onSuccess })

    const result = await rpc.querySafe(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
      responseValidation: 'lenient',
    }))

    expect(result).toEqual({ _tag: 'ok', data: { id: 123 } })
    expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ data: { id: 123 } }))
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      operation: expect.objectContaining({ path: '/api/sites/1' }),
      error: expect.objectContaining({ type: 'response-validation' }),
      recovered: true,
    }))
  })

  it('strict (the default in this unit test environment) still throws on the same mismatch', async () => {
    const onError = vi.fn()
    const rpc = createNuxtRpcClient({ fetch: (async () => ({ id: 123 })) as any, onError })

    const result = await rpc.querySafe(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
    }))

    expect(result._tag).toBe('err')
    if (result._tag === 'err')
      expect(result.error).toMatchObject({ type: 'response-validation' })
    // A thrown (non-recovered) failure never carries `recovered: true`.
    expect(onError).toHaveBeenCalledWith(expect.not.objectContaining({ recovered: true }))
  })

  it('a client-level responseValidation:lenient default applies when the operation does not set it', async () => {
    const onError = vi.fn()
    const rpc = createNuxtRpcClient({
      fetch: (async () => ({ id: 123 })) as any,
      onError,
      responseValidation: 'lenient',
    })

    const result = await rpc.querySafe(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
    }))

    expect(result).toEqual({ _tag: 'ok', data: { id: 123 } })
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ recovered: true }))
  })

  it('the operation responseValidation wins over a lenient client default', async () => {
    const rpc = createNuxtRpcClient({ fetch: (async () => ({ id: 123 })) as any, responseValidation: 'lenient' })

    const result = await rpc.querySafe(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
      responseValidation: 'strict',
    }))

    expect(result._tag).toBe('err')
  })

  it('executeSafe (mutation) also recovers a lenient mismatch and fires onError', async () => {
    const onError = vi.fn()
    const rpc = createNuxtRpcClient({ fetch: (async () => ({ ok: 'yes' })) as any, onError })

    const result = await rpc.executeSafe(defineNuxtRpcMutation({
      body: null,
      method: 'POST',
      path: '/api/sites/1/refresh',
      response: z.object({ ok: z.boolean() }),
      responseValidation: 'lenient',
    }))

    expect(result).toEqual({ _tag: 'ok', data: { ok: 'yes' } })
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ recovered: true }))
  })

  it('request body validation stays strict even when the operation is lenient', async () => {
    const fetch = vi.fn()
    const rpc = createNuxtRpcClient({ fetch: fetch as any })

    const result = await rpc.executeSafe(defineNuxtRpcMutation({
      body: z.object({ name: z.string() }),
      method: 'PATCH',
      path: '/api/sites/1',
      response: z.object({ ok: z.boolean() }),
      responseValidation: 'lenient',
    }), { name: 123 } as any)

    expect(result._tag).toBe('err')
    if (result._tag === 'err')
      expect(result.error).toMatchObject({ type: 'request-validation' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('a parse-only schema slot (no safeParse) works in strict mode', async () => {
    const rpc = createNuxtRpcClient({ fetch: (async () => ({ id: 'abc' })) as any })

    const result = await rpc.querySafe(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: parseOnlySchema(z.object({ id: z.string() })),
    }))

    expect(result).toEqual({ _tag: 'ok', data: { id: 'abc' } })
  })

  it('a parse-only schema slot (no safeParse) recovers in lenient mode instead of throwing "safeParse is not a function"', async () => {
    const onError = vi.fn()
    const rpc = createNuxtRpcClient({ fetch: (async () => ({ id: 123 })) as any, onError })

    const result = await rpc.querySafe(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: parseOnlySchema(z.object({ id: z.string() })),
      responseValidation: 'lenient',
    }))

    expect(result).toEqual({ _tag: 'ok', data: { id: 123 } })
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      recovered: true,
      error: expect.objectContaining({ type: 'response-validation' }),
    }))
  })
})

describe('\'auto\' response validation (the default): dev throws, prod recovers', () => {
  it('resolves to strict under a dev signal: a mismatch still throws', async () => {
    const onError = vi.fn()
    const rpc = createNuxtRpcClient({
      fetch: (async () => ({ id: 123 })) as any,
      onError,
      isDev: () => true,
    })

    const result = await rpc.querySafe(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
    }))

    expect(result._tag).toBe('err')
    if (result._tag === 'err')
      expect(result.error).toMatchObject({ type: 'response-validation' })
    expect(onError).toHaveBeenCalledWith(expect.not.objectContaining({ recovered: true }))
  })

  it('resolves to lenient under a prod signal: a mismatch recovers instead of throwing', async () => {
    const onError = vi.fn()
    const rpc = createNuxtRpcClient({
      fetch: (async () => ({ id: 123 })) as any,
      onError,
      isDev: () => false,
    })

    const result = await rpc.querySafe(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
    }))

    expect(result).toEqual({ _tag: 'ok', data: { id: 123 } })
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      recovered: true,
      error: expect.objectContaining({ type: 'response-validation' }),
    }))
  })

  it('an operation-level responseValidation still wins over a prod isDev signal', async () => {
    const rpc = createNuxtRpcClient({
      fetch: (async () => ({ id: 123 })) as any,
      isDev: () => false,
    })

    const result = await rpc.querySafe(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
      responseValidation: 'strict',
    }))

    expect(result._tag).toBe('err')
  })

  it('mutations resolve \'auto\' the same way as queries', async () => {
    const onError = vi.fn()
    const rpc = createNuxtRpcClient({
      fetch: (async () => ({ ok: 'yes' })) as any,
      onError,
      isDev: () => false,
    })

    const result = await rpc.executeSafe(defineNuxtRpcMutation({
      body: null,
      method: 'POST',
      path: '/api/sites/1/refresh',
      response: z.object({ ok: z.boolean() }),
    }))

    expect(result).toEqual({ _tag: 'ok', data: { ok: 'yes' } })
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ recovered: true }))
  })
})

describe('useNuxtRpcQuery lenient response validation', () => {
  it('lenient transform returns the raw payload on a mismatch instead of throwing', () => {
    const result = useNuxtRpcQuery(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
      responseValidation: 'lenient',
    })) as any

    expect(result.opts.transform({ id: 123 })).toEqual({ id: 123 })
  })

  it('strict transform (the default in this unit test environment) still throws on the same mismatch', () => {
    const result = useNuxtRpcQuery(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
    })) as any

    expect(() => result.opts.transform({ id: 123 })).toThrow()
  })

  it('a query-scope responseValidation:lenient default applies when the operation does not set it', () => {
    const result = useNuxtRpcQuery(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
    }), { responseValidation: 'lenient' }) as any

    expect(result.opts.transform({ id: 123 })).toEqual({ id: 123 })
  })

  it('the operation responseValidation wins over a lenient query-scope default', () => {
    const result = useNuxtRpcQuery(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
      responseValidation: 'strict',
    }), { responseValidation: 'lenient' }) as any

    expect(() => result.opts.transform({ id: 123 })).toThrow()
  })

  it('a parse-only schema slot (no safeParse) recovers under a lenient transform', () => {
    const result = useNuxtRpcQuery(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: parseOnlySchema(z.object({ id: z.string() })),
      responseValidation: 'lenient',
    })) as any

    expect(result.opts.transform({ id: 123 })).toEqual({ id: 123 })
  })

  it('\'auto\' (no responseValidation set) resolves to strict under a dev isDev signal', () => {
    const result = useNuxtRpcQuery(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
    }), { isDev: () => true }) as any

    expect(() => result.opts.transform({ id: 123 })).toThrow()
  })

  it('\'auto\' (no responseValidation set) resolves to lenient under a prod isDev signal', () => {
    const result = useNuxtRpcQuery(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
    }), { isDev: () => false }) as any

    expect(result.opts.transform({ id: 123 })).toEqual({ id: 123 })
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
  const schemaLoad = normalizeNuxtRpcError({ type: 'schema-load', phase: 'response', message: 'load failed', cause: new Error('load failed') })

  it('isRetryableRpcError: timeout/connection/5xx/429 retry, abort/4xx/validation do not', () => {
    expect(isRetryableRpcError(timeout)).toBe(true)
    expect(isRetryableRpcError(connection)).toBe(true)
    expect(isRetryableRpcError(schemaLoad)).toBe(true)
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
    expect(rpcErrorCategory(schemaLoad)).toBe('transient')
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

describe('nuxtRpcError shape', () => {
  it('is a real Error that keeps its tag', () => {
    const error = normalizeNuxtRpcError(Object.assign(new Error('boom'), {
      status: 500,
      response: { status: 500, statusText: 'Server Error' },
    }))

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('NuxtRpcError')
    expect(error.type).toBe('fetch')
    expect(error.message).toBe('boom')
    expect(typeof error.stack).toBe('string')
  })

  it('rebuilds a tagged plain object into an Error', () => {
    const error = normalizeNuxtRpcError({
      type: 'timeout',
      message: 'took too long',
      cause: new Error('TimeoutError'),
    })

    expect(error).toBeInstanceOf(Error)
    expect(error.type).toBe('timeout')
    expect(error.message).toBe('took too long')
  })

  it('makes a validation failure an Error with its issues', () => {
    const schema = z.object({ id: z.string() })
    let error: any
    try {
      schema.parse({ id: 1 })
    }
    catch (thrown) {
      error = normalizeNuxtRpcError(thrown, 'response-validation')
    }

    expect(error).toBeInstanceOf(Error)
    expect(error.type).toBe('response-validation')
    expect(error.issues).toHaveLength(1)
  })
})

describe('useNuxtRpcQuery onError', () => {
  const operation = () => defineNuxtRpcQuery({
    key: 'site:1',
    path: '/api/sites/1',
    response: z.object({ id: z.string() }),
  })

  async function tick() {
    const { nextTick } = await import('vue')
    await nextTick()
  }

  it('reports a query failure through onError', async () => {
    const onError = vi.fn()
    useNuxtRpcQuery(operation(), { onError })

    mocks.queryError!.value = Object.assign(new Error('[GET] "/api/sites/1": 404'), {
      status: 404,
      response: { status: 404, statusText: 'Not Found' },
    })
    await tick()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![0]).toMatchObject({
      error: { status: 404, type: 'fetch' },
      operation: { kind: 'query', method: 'GET', path: '/api/sites/1' },
    })
  })

  it('reports one failure once, however often the error is read', async () => {
    const onError = vi.fn()
    const result = useNuxtRpcQuery(operation(), { onError }) as any

    mocks.queryError!.value = Object.assign(new Error('[GET] "/api/sites/1": 500'), {
      status: 500,
      response: { status: 500, statusText: 'Server Error' },
    })
    await tick()
    void result.error.value
    void result.error.value
    await tick()

    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('keeps onError out of the underlying query options', async () => {
    const result = useNuxtRpcQuery(operation(), { onError: vi.fn() }) as any

    expect(result.opts.onError).toBeUndefined()
  })
})

describe('useNuxtRpcQuery recovered lenient mismatches reach onError', () => {
  it('reports a recovered lenient mismatch through onError, tagged recovered: true', () => {
    const onError = vi.fn()
    const result = useNuxtRpcQuery(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
      responseValidation: 'lenient',
    }), { onError }) as any

    const data = result.opts.transform({ id: 123 })

    // The recovered payload still comes back from transform, unaffected by
    // onError even having been called.
    expect(data).toEqual({ id: 123 })
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      operation: expect.objectContaining({ kind: 'query', path: '/api/sites/1' }),
      error: expect.objectContaining({ type: 'response-validation' }),
      recovered: true,
    }))
  })

  it('reports a recovered mismatch under an \'auto\' prod isDev signal, not only an explicit lenient operation', () => {
    const onError = vi.fn()
    const result = useNuxtRpcQuery(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
    }), { onError, isDev: () => false }) as any

    result.opts.transform({ id: 123 })

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ recovered: true }))
  })

  it('does not call onError with recovered:true for a clean payload (no mismatch)', () => {
    const onError = vi.fn()
    const result = useNuxtRpcQuery(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
      responseValidation: 'lenient',
    }), { onError }) as any

    result.opts.transform({ id: 'abc' })

    expect(onError).not.toHaveBeenCalled()
  })

  it('does not call the recovered reporter on a strict throw (onMismatch never fires)', () => {
    const onError = vi.fn()
    const result = useNuxtRpcQuery(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
      responseValidation: 'strict',
    }), { onError }) as any

    expect(() => result.opts.transform({ id: 123 })).toThrow()
    expect(onError).not.toHaveBeenCalledWith(expect.objectContaining({ recovered: true }))
  })

  it('includes a durationMs on the recovered event once the request timing hook has run', () => {
    const onError = vi.fn()
    const result = useNuxtRpcQuery(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
      responseValidation: 'lenient',
    }), { onError }) as any

    result.opts.onRequest[0]()
    result.opts.transform({ id: 123 })

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ durationMs: expect.any(Number), recovered: true }))
  })

  it('an onError that throws does not turn the recovered payload into a failure', () => {
    const onError = vi.fn(() => {
      throw new Error('boom')
    })
    const result = useNuxtRpcQuery(defineNuxtRpcQuery({
      key: 'site:1',
      path: '/api/sites/1',
      response: z.object({ id: z.string() }),
      responseValidation: 'lenient',
    }), { onError }) as any

    expect(() => result.opts.transform({ id: 123 })).not.toThrow()
    expect(onError).toHaveBeenCalledOnce()
  })
})
