// Shell wiring for `useNuxtSubscription` against a real `useNuxtApp()`:
// hydration-deferred establish, parse-at-boundary, callbacks running in Nuxt
// context (so the cache helpers resolve), enabled gating, and scope teardown.

import type { NuxtSubscriptionSource } from 'nuxt-use-query/subscription'
import { getQueryData, setQueryData } from 'nuxt-use-query/query-cache'
import { useNuxtSubscription } from 'nuxt-use-query/subscription'
import { describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, onScopeDispose, ref } from 'vue'

// onNuxtReady defers via requestIdleCallback/setTimeout; give it room to fire.
const ready = () => new Promise(r => setTimeout(r, 50))

describe('useNuxtSubscription · nuxt-env (in-process Nuxt)', () => {
  it('establishes after hydration and delivers a message into the cache', async () => {
    let ctx: NuxtSubscriptionSource | undefined
    const sub = useNuxtSubscription<{ key: string, value: number }>({
      source: (c) => { ctx = c },
      onMessage: msg => void setQueryData(msg.key, { value: msg.value }),
    })

    // Deferred to onNuxtReady — not connected synchronously at setup.
    expect(ctx).toBeUndefined()
    expect(sub.status.value).toBe('idle')

    await ready()
    expect(sub.status.value).toBe('active')

    await ctx!.push({ key: 'sub-1', value: 42 })
    // onMessage ran in Nuxt context → setQueryData reached the live cache.
    expect(getQueryData<{ value: number }>('sub-1')).toEqual({ value: 42 })
  })

  it('keeps Nuxt context available after an async message-handler boundary', async () => {
    let ctx: NuxtSubscriptionSource | undefined
    useNuxtSubscription<{ key: string, value: number }>({
      source: (c) => { ctx = c },
      onMessage: async (msg) => {
        await Promise.resolve()
        setQueryData(msg.key, { value: msg.value })
      },
    })
    await ready()

    await ctx!.push({ key: 'sub-async-context', value: 73 })
    expect(getQueryData<{ value: number }>('sub-async-context')).toEqual({ value: 73 })
  })

  it('parses untrusted frames at the boundary before onMessage', async () => {
    const onMessage = vi.fn()
    let ctx: NuxtSubscriptionSource | undefined
    useNuxtSubscription<{ n: number }>({
      source: (c) => { ctx = c },
      // A schema with a `.parse` method (Zod-shaped) coerces the frame.
      schema: { parse: (raw: any) => ({ n: Number(raw.n) }) },
      onMessage,
    })
    await ready()

    await ctx!.push({ n: '7' })
    expect(onMessage).toHaveBeenCalledWith({ n: 7 })
  })

  it('routes a parse failure to onError without calling onMessage', async () => {
    const onMessage = vi.fn()
    const onError = vi.fn()
    let ctx: NuxtSubscriptionSource | undefined
    const sub = useNuxtSubscription({
      source: (c) => { ctx = c },
      schema: () => { throw new Error('bad frame') },
      onMessage,
      onError,
    })
    await ready()

    await expect(ctx!.push({ anything: true })).rejects.toThrow('bad frame')
    expect(onMessage).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(sub.error.value).toBeInstanceOf(Error)
  })

  it('never connects while disabled', async () => {
    const source = vi.fn()
    const sub = useNuxtSubscription({
      source,
      onMessage: () => {},
      enabled: false,
    })
    await ready()

    expect(source).not.toHaveBeenCalled()
    expect(sub.status.value).toBe('idle')
  })

  it('tears down on scope dispose: aborts the signal and runs cleanup', async () => {
    const cleanup = vi.fn()
    let ctx: NuxtSubscriptionSource | undefined
    const scope = effectScope()
    scope.run(() => {
      useNuxtSubscription({
        source: (c) => {
          ctx = c
          return cleanup
        },
        onMessage: () => {},
      })
    })
    await ready()
    expect(ctx!.signal.aborted).toBe(false)

    scope.stop()
    expect(ctx!.signal.aborted).toBe(true)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('hosts the source in an effect scope: composable cleanup runs on teardown', async () => {
    // A source that registers `onScopeDispose` (what a channel composable /
    // `useWebSocket` does internally) must be torn down even though it runs
    // post-hydration, outside the calling component scope.
    const disposed = vi.fn()
    const scope = effectScope()
    scope.run(() => {
      useNuxtSubscription({
        source: () => { onScopeDispose(disposed) },
        onMessage: () => {},
      })
    })
    await ready()
    expect(disposed).not.toHaveBeenCalled()

    scope.stop()
    expect(disposed).toHaveBeenCalledTimes(1)
  })

  it('still stops the source effect scope when the returned cleanup throws', async () => {
    const disposed = vi.fn()
    const cleanupError = new Error('transport cleanup failed')
    const onError = vi.fn()
    const scope = effectScope()
    scope.run(() => {
      useNuxtSubscription({
        source: () => {
          onScopeDispose(disposed)
          return () => {
            throw cleanupError
          }
        },
        onMessage: () => {},
        onError,
      })
    })
    await ready()

    scope.stop()
    expect(disposed).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(cleanupError)
  })

  it('awaits a typed onResync effect when the source signals recovery', async () => {
    const onResync = vi.fn(async (_request: { cursor: string }) => {})
    let ctx: NuxtSubscriptionSource<{ cursor: string }> | undefined
    useNuxtSubscription<unknown, { cursor: string }>({
      source: (c) => { ctx = c },
      onMessage: () => {},
      onResync,
    })
    await ready()

    await ctx!.resync({ cursor: '42' })
    expect(onResync).toHaveBeenCalledWith({ cursor: '42' })
  })

  it('propagates an async message rejection while reporting it through onError', async () => {
    const boom = new Error('cache effect failed')
    const onError = vi.fn()
    let ctx: NuxtSubscriptionSource | undefined
    const sub = useNuxtSubscription({
      source: (c) => { ctx = c },
      onMessage: async () => { throw boom },
      onError,
    })
    await ready()

    await expect(ctx!.push('frame')).rejects.toBe(boom)
    expect(onError).toHaveBeenCalledWith(boom)
    expect(sub.error.value).toBe(boom)
  })

  it('an async source: its returned cleanup AND synchronous onScopeDispose both run on teardown', async () => {
    const disposed = vi.fn()
    const cleanup = vi.fn()
    const scope = effectScope()
    scope.run(() => {
      useNuxtSubscription({
        // Composable registered synchronously (before the await), as documented.
        source: async () => {
          onScopeDispose(disposed)
          await Promise.resolve()
          return cleanup
        },
        onMessage: () => {},
      })
    })
    await ready()

    scope.stop()
    expect(disposed).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('re-establishes through the enabled watch: toggling re-runs source and cleans up', async () => {
    const cleanup = vi.fn()
    const source = vi.fn(() => cleanup)
    const enabled = ref(true)
    useNuxtSubscription({ source, onMessage: () => {}, enabled })
    await ready()
    expect(source).toHaveBeenCalledTimes(1)

    enabled.value = false
    await nextTick()
    expect(cleanup).toHaveBeenCalledTimes(1)

    enabled.value = true
    await nextTick()
    expect(source).toHaveBeenCalledTimes(2)
  })

  it('does not establish if the scope disposes before onNuxtReady fires', async () => {
    const source = vi.fn()
    const scope = effectScope()
    scope.run(() => {
      useNuxtSubscription({ source, onMessage: () => {} })
    })
    // Unmount before the idle callback that establishes the source.
    scope.stop()
    await ready()

    expect(source).not.toHaveBeenCalled()
  })
})
