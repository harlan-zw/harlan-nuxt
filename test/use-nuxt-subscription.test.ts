import type { SubscriptionContextBase } from 'nuxt-use-query/subscription'
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
  const reconnects = vi.fn()
  const controller = createSubscriptionController({
    source,
    handleMessage: raw => void messages.push(raw),
    handleReconnect: reconnects,
    handleError: err => void errors.push(err),
    setStatus: s => void statuses.push(s),
  })
  return { controller, statuses, errors, messages, reconnects }
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
    expect(ctx.push).toBeTypeOf('function')
    expect(ctx.resync).toBeTypeOf('function')
    expect(statuses).toEqual(['connecting', 'active'])
  })

  it('delivers pushes while active and drops them after deactivate', () => {
    let ctx!: SubscriptionContextBase
    const { controller, messages } = harness((c) => {
      ctx = c
      return () => {}
    })

    controller.activate()
    ctx.push('a')
    ctx.push('b')
    controller.deactivate()
    ctx.push('c') // arrives after teardown — must be dropped

    expect(messages).toEqual(['a', 'b'])
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

  it('a push from a stale async establishment is dropped', async () => {
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

    ctx.push('late') // transport still holds the old ctx
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

  it('resync runs the reconnect handler only while active', () => {
    let ctx!: SubscriptionContextBase
    const { controller, reconnects } = harness((c) => {
      ctx = c
      return () => {}
    })

    controller.activate()
    ctx.resync()
    controller.deactivate()
    ctx.resync() // post-teardown — ignored

    expect(reconnects).toHaveBeenCalledTimes(1)
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
