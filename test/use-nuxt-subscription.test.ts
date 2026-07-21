import type { SubscriptionContextBase } from 'nuxt-use-query/subscription'
import { runInNewContext } from 'node:vm'
import { createSubscriptionController } from 'nuxt-use-query/subscription'
import { describe, expect, it, vi } from 'vitest'

// Unit coverage for the pure establish/teardown state machine — the part that
// holds the async-establish + disable race. No Vue, no Nuxt.

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function harness(source: (ctx: SubscriptionContextBase) => any) {
  const statuses: string[] = []
  const errors: unknown[] = []
  const messages: unknown[] = []
  const resyncs = vi.fn()
  const controller = createSubscriptionController({
    source,
    handleMessage: raw => void messages.push(raw),
    handleResync: resyncs,
    handleError: err => void errors.push(err),
    setStatus: s => void statuses.push(s),
  })
  return { controller, statuses, errors, messages, resyncs }
}

const flush = () => new Promise(r => setTimeout(r, 0))

describe('createSubscriptionController', () => {
  it('activates a sync source: connecting → active, source called with a context', () => {
    const source = vi.fn(() => () => {})
    const { controller, statuses } = harness(source)

    controller.activate()

    expect(source).toHaveBeenCalledTimes(1)
    const ctx = source.mock.calls[0][0] as SubscriptionContextBase
    expect(ctx.signal).toBeInstanceOf(AbortSignal)
    expect(ctx.fail).toBeTypeOf('function')
    expect(ctx.push).toBeTypeOf('function')
    expect(ctx.resync).toBeTypeOf('function')
    expect(statuses).toEqual(['connecting', 'active'])
  })

  it('delivers pushes while active and rejects them after deactivate', async () => {
    let ctx!: SubscriptionContextBase
    const { controller, messages } = harness((c) => {
      ctx = c
      return () => {}
    })

    controller.activate()
    await ctx.push('a')
    await ctx.push('b')
    controller.deactivate()
    await expect(ctx.push('c')).rejects.toMatchObject({ name: 'AbortError' })

    expect(messages).toEqual(['a', 'b'])
  })

  it('runs message effects in FIFO order', async () => {
    const first = deferred<void>()
    const order: string[] = []
    let ctx!: SubscriptionContextBase
    const controller = createSubscriptionController({
      source: (c) => { ctx = c },
      handleMessage: async (raw) => {
        order.push(`start:${raw}`)
        if (raw === 'a')
          await first.promise
        order.push(`end:${raw}`)
      },
      handleResync: () => {},
      handleError: () => {},
      setStatus: () => {},
    })
    controller.activate()

    const a = ctx.push('a')
    const b = ctx.push('b')
    await Promise.resolve()
    expect(order).toEqual(['start:a'])

    first.resolve(undefined)
    await Promise.all([a, b])
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b'])
  })

  it('propagates an effect rejection and recovers the FIFO for later work', async () => {
    const boom = new Error('effect failed')
    const errors: unknown[] = []
    const messages: unknown[] = []
    let ctx!: SubscriptionContextBase
    const controller = createSubscriptionController({
      source: (c) => { ctx = c },
      handleMessage: (raw) => {
        if (raw === 'bad')
          throw boom
        messages.push(raw)
      },
      handleResync: () => {},
      handleError: error => void errors.push(error),
      setStatus: () => {},
    })
    controller.activate()

    await expect(ctx.push('bad')).rejects.toBe(boom)
    await expect(ctx.push('good')).resolves.toBeUndefined()
    expect(errors).toEqual([boom])
    expect(messages).toEqual(['good'])
  })

  it('reports source-side failures through the same FIFO', async () => {
    const boom = new Error('decode failed')
    let ctx!: SubscriptionContextBase
    const { controller, errors } = harness((c) => {
      ctx = c
    })
    controller.activate()

    await expect(ctx.fail(boom)).rejects.toBe(boom)

    expect(errors).toEqual([boom])
  })

  it('rejects queued work that becomes stale during teardown', async () => {
    const first = deferred<void>()
    const effects: unknown[] = []
    const errors: unknown[] = []
    let ctx!: SubscriptionContextBase
    const controller = createSubscriptionController({
      source: (c) => { ctx = c },
      handleMessage: async (raw) => {
        effects.push(raw)
        if (raw === 'in-flight')
          await first.promise
      },
      handleResync: () => {},
      handleError: error => void errors.push(error),
      setStatus: () => {},
    })
    controller.activate()

    const inFlight = ctx.push('in-flight')
    const queued = ctx.push('queued')
    await Promise.resolve()
    controller.deactivate()
    first.resolve(undefined)

    await expect(inFlight).resolves.toBeUndefined()
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(effects).toEqual(['in-flight'])
    expect(errors).toEqual([])
  })

  it('deactivate runs the returned cleanup and aborts the signal', () => {
    const cleanup = vi.fn()
    let ctx!: SubscriptionContextBase
    const { controller, statuses } = harness((c) => {
      ctx = c
      return cleanup
    })

    controller.activate()
    expect(ctx.signal.aborted).toBe(false)
    controller.deactivate()

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(ctx.signal.aborted).toBe(true)
    expect(statuses.at(-1)).toBe('idle')
  })

  it('is idempotent: double activate establishes once', () => {
    const source = vi.fn(() => () => {})
    const { controller } = harness(source)

    controller.activate()
    controller.activate()

    expect(source).toHaveBeenCalledTimes(1)
  })

  it('re-activates cleanly after a deactivate', () => {
    const source = vi.fn(() => () => {})
    const { controller } = harness(source)

    controller.activate()
    controller.deactivate()
    controller.activate()

    expect(source).toHaveBeenCalledTimes(2)
  })

  it('aborts the context signal when the source fails', () => {
    let ctx!: SubscriptionContextBase
    const { controller } = harness((c) => {
      ctx = c
      throw new Error('connect failed')
    })

    controller.activate()
    // A source that wired teardown to `ctx.signal` still gets aborted on failure.
    expect(ctx.signal.aborted).toBe(true)
  })

  it('a sync source throw surfaces an error and leaves it re-activatable', () => {
    const boom = new Error('connect failed')
    const source = vi.fn(() => {
      throw boom
    })
    const { controller, statuses, errors } = harness(source)

    controller.activate()
    expect(errors).toEqual([boom])
    expect(statuses).toEqual(['connecting', 'error'])

    // error is terminal-but-not-active: a fresh activate retries.
    controller.activate()
    expect(source).toHaveBeenCalledTimes(2)
  })

  it('async source: stays connecting until resolve, then active; cleanup stored', async () => {
    const d = deferred<() => void>()
    const cleanup = vi.fn()
    const { controller, statuses } = harness(() => d.promise)

    controller.activate()
    expect(statuses).toEqual(['connecting'])

    d.resolve(cleanup)
    await flush()
    expect(statuses).toEqual(['connecting', 'active'])

    controller.deactivate()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('recognizes an async source Promise from another realm', async () => {
    const cleanup = vi.fn()
    const promise = runInNewContext('Promise.resolve(cleanup)', { cleanup }) as Promise<() => void>
    const { controller, statuses } = harness(() => promise)

    controller.activate()
    expect(statuses).toEqual(['connecting'])

    await flush()
    expect(statuses).toEqual(['connecting', 'active'])

    controller.deactivate()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('async source resolving after deactivate tears the stale connection down, never goes active', async () => {
    const d = deferred<() => void>()
    const cleanup = vi.fn()
    const { controller, statuses } = harness(() => d.promise)

    controller.activate() // connecting…
    controller.deactivate() // disabled before it resolved → idle

    d.resolve(cleanup) // the connection finally established into a stale epoch
    await flush()

    // Stale cleanup invoked immediately; never advertised 'active'.
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(statuses).toEqual(['connecting', 'idle'])
  })

  it('a push from a stale async establishment rejects', async () => {
    const d = deferred<() => void>()
    let ctx!: SubscriptionContextBase
    const { controller, messages } = harness((c) => {
      ctx = c
      return d.promise
    })

    controller.activate()
    controller.deactivate()
    d.resolve(() => {})
    await flush()

    await expect(ctx.push('late')).rejects.toMatchObject({ name: 'AbortError' })
    expect(messages).toEqual([])
  })

  it('an async source rejection surfaces an error', async () => {
    const d = deferred<() => void>()
    const boom = new Error('handshake rejected')
    const { controller, statuses, errors } = harness(() => d.promise)

    controller.activate()
    d.reject(boom)
    await flush()

    expect(errors).toEqual([boom])
    expect(statuses).toEqual(['connecting', 'error'])
  })

  it('resync runs its handler only while active and rejects after teardown', async () => {
    let ctx!: SubscriptionContextBase
    const { controller, resyncs } = harness((c) => {
      ctx = c
      return () => {}
    })

    controller.activate()
    await ctx.resync()
    controller.deactivate()
    await expect(ctx.resync()).rejects.toMatchObject({ name: 'AbortError' })

    expect(resyncs).toHaveBeenCalledTimes(1)
  })

  it('queues typed resync requests in the same FIFO as messages', async () => {
    interface Request { cursor: string }
    let ctx!: SubscriptionContextBase<Request>
    const effects: string[] = []
    const controller = createSubscriptionController<Request>({
      source: (c) => { ctx = c },
      handleMessage: raw => void effects.push(`message:${raw}`),
      handleResync: request => void effects.push(`resync:${request.cursor}`),
      handleError: () => {},
      setStatus: () => {},
    })
    controller.activate()

    await Promise.all([
      ctx.push('a'),
      ctx.resync({ cursor: '17' }),
      ctx.push('b'),
    ])
    expect(effects).toEqual(['message:a', 'resync:17', 'message:b'])
  })

  it('a cleanup that throws is reported, not propagated', () => {
    const cleanup = vi.fn(() => {
      throw new Error('cleanup boom')
    })
    const { controller, errors } = harness(() => cleanup)

    controller.activate()
    expect(() => controller.deactivate()).not.toThrow()
    expect(errors).toHaveLength(1)
  })
})
