// `nuxtWebSocketSource` driven through the REAL bridge (the isolated unit test
// mocks vueuse and calls the factory directly; this proves the reconnect →
// `ctx.resync` → `onResync` and frame → `onMessage` chain end-to-end).

import { useNuxtSubscription } from '@harlanzw/nuxt-use-query/subscription'
import { nuxtWebSocketSource } from '@harlanzw/nuxt-use-query/websocket'
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

const hoisted = vi.hoisted(() => ({ opts: undefined as any, close: vi.fn() }))

vi.mock('@vueuse/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@vueuse/core')>()),
  useWebSocket: vi.fn((_url: unknown, options: any) => {
    hoisted.opts = options
    return { status: ref('CONNECTING'), close: hoisted.close }
  }),
}))

const ready = () => new Promise(r => setTimeout(r, 50))

describe('nuxtWebSocketSource · through the bridge (nuxt-env)', () => {
  it('delivers frames to onMessage and runs onResync only on reconnect', async () => {
    const onMessage = vi.fn()
    const onResync = vi.fn()
    useNuxtSubscription<{ k: number }>({
      source: nuxtWebSocketSource('wss://example.com/ws'),
      onMessage,
      onResync,
    })
    await ready()

    hoisted.opts.onConnected() // initial connect
    expect(onResync).not.toHaveBeenCalled()

    hoisted.opts.onMessage(null, { data: '{"k":1}' })
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledWith({ k: 1 }))

    hoisted.opts.onConnected() // reconnect → onResync
    await vi.waitFor(() => expect(onResync).toHaveBeenCalledTimes(1))
  })

  it('observes socket callback rejections while the bridge reports the effect error', async () => {
    const boom = new Error('cache effect rejected')
    const onError = vi.fn()
    const sub = useNuxtSubscription({
      source: nuxtWebSocketSource('wss://example.com/ws'),
      onMessage: async () => { throw boom },
      onError,
    })
    await ready()

    // VueUse/WebSocket callbacks cannot await a Promise. The adapter attaches
    // the observer, while the bridge still exposes the original failure.
    hoisted.opts.onMessage(null, { data: '{"k":1}' })
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(boom))
    expect(sub.error.value).toBe(boom)
  })
})
