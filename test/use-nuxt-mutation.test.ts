import { beforeEach, describe, expect, it, vi } from 'vitest'

// Unit tests for `useNuxtMutation`. We mock `invalidateNuxtQueries` from the
// cache module so these tests assert the mutation calls it with the right key
// prefixes. Refresh behaviour is covered by the cache-helper tests.

const invalidateSpy = vi.fn()

vi.mock('../src/runtime/composables/useQueryCache', () => ({
  invalidateNuxtQueries: invalidateSpy,
}))

const { useNuxtMutation } = await import('nuxt-use-query/mutation')

beforeEach(() => {
  invalidateSpy.mockClear()
})

describe('useNuxtMutation success path', () => {
  it('runs the mutation, invalidates each prefix, then calls onSuccess', async () => {
    const onSuccess = vi.fn()
    const m = useNuxtMutation<{ id: string }, { ok: boolean }>({
      mutation: async ({ id }) => ({ ok: id === 'a' }),
      invalidates: ['pro-backlinks-', 'pro-sites-'],
      onSuccess,
    })

    const result = await m.mutate({ id: 'a' })

    expect(result).toEqual({ ok: true })
    expect(invalidateSpy).toHaveBeenCalledTimes(2)
    expect(invalidateSpy).toHaveBeenCalledWith('pro-backlinks-')
    expect(invalidateSpy).toHaveBeenCalledWith('pro-sites-')
    expect(onSuccess).toHaveBeenCalledWith({ ok: true }, { id: 'a' }, undefined)
    expect(m.pending.value).toBe(false)
    expect(m.error.value).toBeNull()
  })

  it('accepts a function form of invalidates with args + result', async () => {
    const m = useNuxtMutation<{ siteId: string }, { rev: number }>({
      mutation: async () => ({ rev: 7 }),
      invalidates: ({ siteId }, result) => [`pro-site-${siteId}-${result.rev}`],
    })

    await m.mutate({ siteId: 'x9' })

    expect(invalidateSpy).toHaveBeenCalledExactlyOnceWith('pro-site-x9-7')
  })

  it('toggles pending while the mutation is in flight', async () => {
    let release!: () => void
    const m = useNuxtMutation({
      mutation: () => new Promise<void>((r) => { release = r }),
    })

    const p = m.mutate()
    expect(m.pending.value).toBe(true)
    expect(m.isPending.value).toBe(true)
    release()
    await p
    expect(m.pending.value).toBe(false)
    expect(m.isPending.value).toBe(false)
  })
})

describe('useNuxtMutation onMutate + context', () => {
  it('runs onMutate before the mutation and threads its return value to onSuccess', async () => {
    const order: string[] = []
    let receivedContext: unknown
    const m = useNuxtMutation<{ id: string }, { ok: true }, { snapshot: number }>({
      onMutate: (args) => {
        order.push(`mutate:${args.id}`)
        return { snapshot: 42 }
      },
      mutation: async (args) => {
        order.push(`fn:${args.id}`)
        return { ok: true }
      },
      onSuccess: (_result, _args, ctx) => {
        order.push('success')
        receivedContext = ctx
      },
    })

    await m.mutate({ id: 'a' })

    expect(order).toEqual(['mutate:a', 'fn:a', 'success'])
    expect(receivedContext).toEqual({ snapshot: 42 })
  })

  it('threads the onMutate context to onError on failure (rollback site)', async () => {
    let rollbackWith: unknown
    const boom = new Error('boom')
    const m = useNuxtMutation<void, void, { previous: string }>({
      onMutate: () => ({ previous: 'snapshot-value' }),
      mutation: async () => { throw boom },
      onError: (_err, _args, ctx) => { rollbackWith = ctx },
    })

    await m.mutate()

    expect(rollbackWith).toEqual({ previous: 'snapshot-value' })
  })

  it('onSettled fires on both success and error with the right (data,error) shape', async () => {
    const settledCalls: Array<{ data: unknown, error: unknown }> = []
    const okMutation = useNuxtMutation<void, string>({
      mutation: async () => 'ok',
      onSettled: (data, error) => settledCalls.push({ data, error }),
    })
    await okMutation.mutate()

    const errMutation = useNuxtMutation<void, string>({
      mutation: async () => { throw new Error('x') },
      onError: () => undefined,
      onSettled: (data, error) => settledCalls.push({ data, error }),
    })
    await errMutation.mutate()

    expect(settledCalls).toEqual([
      { data: 'ok', error: null },
      { data: undefined, error: expect.any(Error) },
    ])
  })

  it('treats an onMutate throw as a mutation failure (does not run the mutation fn)', async () => {
    const fn = vi.fn()
    const m = useNuxtMutation({
      onMutate: () => { throw new Error('cant snapshot') },
      mutation: fn,
      onError: () => undefined,
    })

    await m.mutate()

    expect(fn).not.toHaveBeenCalled()
    expect(m.error.value).toBeInstanceOf(Error)
    expect(m.pending.value).toBe(false)
  })
})

describe('useNuxtMutation error path', () => {
  it('swallows the error and records it when onError is provided', async () => {
    const onError = vi.fn()
    const boom = new Error('nope')
    const m = useNuxtMutation({
      mutation: async () => { throw boom },
      invalidates: ['pro-x-'],
      onError,
    })

    await expect(m.mutate()).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledWith(boom, undefined, undefined)
    expect(m.error.value).toBe(boom)
    expect(m.pending.value).toBe(false)
    expect(invalidateSpy).not.toHaveBeenCalled()
  })

  it('re-throws the error when no onError is provided', async () => {
    const boom = new Error('unhandled')
    const m = useNuxtMutation({
      mutation: async () => {
        throw boom
      },
    })

    await expect(m.mutate()).rejects.toBe(boom)
    expect(m.error.value).toBe(boom)
    expect(m.pending.value).toBe(false)
  })
})
