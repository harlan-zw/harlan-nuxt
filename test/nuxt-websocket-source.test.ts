import type { SubscriptionContextBase } from 'nuxt-use-query/subscription'
import { describe, expect, it, vi } from 'vitest'

// Capture the options `useWebSocket` was called with so we can drive its
// callbacks (onConnected / onMessage) by hand. (Teardown closes via scope
// dispose through the real bridge — covered in the nuxt-env test.)
const hoisted = vi.hoisted(() => ({
  lastOptions: undefined as any,
  close: vi.fn(),
}))

vi.mock('@vueuse/core', () => ({
  useWebSocket: vi.fn((_url: unknown, options: any) => {
    hoisted.lastOptions = options
    return { close: hoisted.close }
  }),
}))

const { nuxtWebSocketSource } = await import('nuxt-use-query/websocket')

function fakeCtx() {
  const ac = new AbortController()
  return {
    push: vi.fn(async () => {}),
    resync: vi.fn(async () => {}),
    signal: ac.signal,
  } satisfies SubscriptionContextBase
}

describe('nuxtWebSocketSource', () => {
  it('pushes deserialized frames (JSON strings parsed) into the bridge', () => {
    hoisted.close.mockClear()
    const ctx = fakeCtx()
    nuxtWebSocketSource('wss://x/ws')(ctx)

    hoisted.lastOptions.onMessage(null, { data: '{"siteId":"7"}' })
    expect(ctx.push).toHaveBeenCalledWith({ siteId: '7' })
  })

  it('passes a non-JSON frame through untouched', () => {
    const ctx = fakeCtx()
    nuxtWebSocketSource('wss://x/ws')(ctx)

    hoisted.lastOptions.onMessage(null, { data: 'pong' })
    expect(ctx.push).toHaveBeenCalledWith('pong')
  })

  it('honours a custom deserialize', () => {
    const ctx = fakeCtx()
    nuxtWebSocketSource('wss://x/ws', { deserialize: () => ({ forced: true }) })(ctx)

    hoisted.lastOptions.onMessage(null, { data: 'anything' })
    expect(ctx.push).toHaveBeenCalledWith({ forced: true })
  })

  it('re-syncs on reconnect but NOT on the first connect', () => {
    const ctx = fakeCtx()
    nuxtWebSocketSource('wss://x/ws')(ctx)

    hoisted.lastOptions.onConnected() // initial establishment
    expect(ctx.resync).not.toHaveBeenCalled()

    hoisted.lastOptions.onConnected() // reconnect
    hoisted.lastOptions.onConnected() // reconnect
    expect(ctx.resync).toHaveBeenCalledTimes(2)
  })

  it('forwards transport options (heartbeat / autoReconnect / protocols) to useWebSocket', async () => {
    const { useWebSocket } = await import('@vueuse/core')
    const ctx = fakeCtx()
    nuxtWebSocketSource('wss://x/ws', {
      heartbeat: true,
      autoReconnect: { retries: 3 },
      protocols: ['v1'],
    })(ctx)

    expect(useWebSocket).toHaveBeenCalledWith('wss://x/ws', expect.objectContaining({
      heartbeat: true,
      autoReconnect: { retries: 3 },
      immediate: true,
      protocols: ['v1'],
    }))
  })
})
