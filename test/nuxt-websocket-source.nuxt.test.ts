// `nuxtWebSocketSource` driven through the REAL bridge (the isolated unit test
// mocks vueuse and calls the factory directly; this proves the reconnect →
// `ctx.resync` → `onReconnect` and frame → `onMessage` chain end-to-end).

import { useNuxtSubscription } from 'nuxt-use-query/subscription'
import { nuxtWebSocketSource } from 'nuxt-use-query/websocket'
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
  it('delivers frames to onMessage and fires onReconnect only on reconnect', async () => {
    const onMessage = vi.fn()
    const onReconnect = vi.fn()
    useNuxtSubscription<{ k: number }>({
      source: nuxtWebSocketSource('wss://example.com/ws'),
      onMessage,
      onReconnect,
    })
    await ready()

    hoisted.opts.onConnected() // initial connect
    expect(onReconnect).not.toHaveBeenCalled()

    hoisted.opts.onMessage(null, { data: '{"k":1}' })
    expect(onMessage).toHaveBeenCalledWith({ k: 1 })

    hoisted.opts.onConnected() // reconnect → onReconnect
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })
})
