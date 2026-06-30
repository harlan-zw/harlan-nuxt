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

  it('runs onError rollback before onSettled observes final state', async () => {
    const order: string[] = []
    const m = useNuxtMutation<void, void, { rolledBack: boolean }>({
      onMutate: () => ({ rolledBack: false }),
      mutation: async () => { throw new Error('x') },
      onError: (_error, _args, context) => {
        order.push('error')
        if (context)
          context.rolledBack = true
      },
      onSettled: (_data, _error, _args, context) => {
        order.push(`settled:${context?.rolledBack}`)
      },
    })

    await m.mutate()

    expect(order).toEqual(['error', 'settled:true'])
  })

  it('keeps pending true until all concurrent mutations settle', async () => {
    const releases: Array<() => void> = []
    const m = useNuxtMutation({
      mutation: () => new Promise<void>((resolve) => {
        releases.push(resolve)
      }),
    })

    const first = m.mutate()
    const second = m.mutate()
    expect(m.pending.value).toBe(true)

    releases[0]!()
    await first
    expect(m.pending.value).toBe(true)

    releases[1]!()
    await second
    expect(m.pending.value).toBe(false)
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

describe('useNuxtMutation mutateSafe (errors-as-values)', () => {
  it('returns an ok-tagged result on success without throwing', async () => {
    const m = useNuxtMutation<{ id: string }, { ok: boolean }>({
      mutation: async ({ id }) => ({ ok: id === 'a' }),
      invalidates: ['pro-x-'],
    })

    const result = await m.mutateSafe({ id: 'a' })

    expect(result).toEqual({ _tag: 'ok', data: { ok: true } })
    expect(invalidateSpy).toHaveBeenCalledExactlyOnceWith('pro-x-')
    expect(m.error.value).toBeNull()
    expect(m.pending.value).toBe(false)
  })

  it('returns an err-tagged result on failure without throwing, even with no onError', async () => {
    const boom = new Error('nope')
    const m = useNuxtMutation({
      mutation: async () => { throw boom },
      invalidates: ['pro-x-'],
    })

    const result = await m.mutateSafe()

    expect(result).toEqual({ _tag: 'err', error: boom })
    expect(m.error.value).toBe(boom)
    expect(m.pending.value).toBe(false)
    expect(invalidateSpy).not.toHaveBeenCalled()
  })

  it('returns an err-tagged result when onMutate throws', async () => {
    const fn = vi.fn()
    const boom = new Error('cant snapshot')
    const m = useNuxtMutation({
      onMutate: () => { throw boom },
      mutation: fn,
    })

    const result = await m.mutateSafe()

    expect(result).toEqual({ _tag: 'err', error: boom })
    expect(fn).not.toHaveBeenCalled()
  })

  it('still fires onSettled + onError side-effects while returning the err value', async () => {
    const onError = vi.fn()
    const onSettled = vi.fn()
    const boom = new Error('x')
    const m = useNuxtMutation({
      mutation: async () => { throw boom },
      onError,
      onSettled,
    })

    const result = await m.mutateSafe()

    expect(result._tag).toBe('err')
    expect(onError).toHaveBeenCalledWith(boom, undefined, undefined)
    expect(onSettled).toHaveBeenCalledWith(undefined, boom, undefined, undefined)
  })
})

describe('useNuxtMutation hook isolation', () => {
  it('mutateSafe still resolves the err value when onError throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const boom = new Error('mutation failed')
    const m = useNuxtMutation({
      mutation: async () => { throw boom },
      onError: () => { throw new Error('reporting hook blew up') },
    })

    const r = await m.mutateSafe()

    expect(r).toEqual({ _tag: 'err', error: boom })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('mutateSafe still resolves when onSettled throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const m = useNuxtMutation({
      mutation: async () => { throw new Error('fail') },
      onSettled: () => { throw new Error('settle blew up') },
    })

    const r = await m.mutateSafe()

    expect(r._tag).toBe('err')
    spy.mockRestore()
  })

  it('mutate() throws the rollback failure so the caller can observe it (not a clean resolve)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rollbackError = new Error('rollback failed')
    const m = useNuxtMutation<void, void, { previous: string }>({
      onMutate: () => ({ previous: 'snapshot' }),
      mutation: async () => { throw new Error('mutation failed') },
      onError: () => { throw rollbackError },
    })

    await expect(m.mutate()).rejects.toBe(rollbackError)
    spy.mockRestore()
  })

  it('awaits an async onError so its rejection is captured, not left dangling', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rollbackError = new Error('async rollback rejected')
    const m = useNuxtMutation({
      mutation: async () => { throw new Error('mutation failed') },
      onError: async () => { throw rollbackError },
    })

    // mutate() (throwing variant) surfaces it; mutateSafe still resolves err.
    await expect(m.mutate()).rejects.toBe(rollbackError)
    const safe = useNuxtMutation({
      mutation: async () => { throw new Error('x') },
      onError: async () => { throw new Error('async reject') },
    })
    await expect(safe.mutateSafe()).resolves.toMatchObject({ _tag: 'err' })
    spy.mockRestore()
  })

  it('a throwing onSuccess does not flip a successful mutateSafe to err, nor fire onError', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onError = vi.fn()
    const m = useNuxtMutation<void, { ok: boolean }>({
      mutation: async () => ({ ok: true }),
      onSuccess: () => { throw new Error('success hook blew up') },
      onError,
    })

    const r = await m.mutateSafe()

    expect(r).toEqual({ _tag: 'ok', data: { ok: true } })
    expect(onError).not.toHaveBeenCalled()
    expect(m.pending.value).toBe(false)
    spy.mockRestore()
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
