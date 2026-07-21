import type { UseWebSocketOptions } from '@vueuse/core'
import type { MaybeRefOrGetter } from 'vue'
import type { SubscriptionContextBase } from './composables/useNuxtSubscription'
import { useWebSocket } from '@vueuse/core'

// A `source` factory for `useNuxtSubscription`, built on VueUse's `useWebSocket`
// (already a dependency, free in every Nuxt app). It keeps the bridge itself
// transport-agnostic — this is just one adapter that produces a `source`.
//
// What it wires for you:
//   - each socket frame -> the FIFO `ctx.push` effect (deserialized)
//   - every *re*connect -> `ctx.resync()`, so the bridge's `onResync` runs
//     and recovers events missed while the socket was down (the gap a bare
//     `useNuxtQuery` refetch-on-reconnect can't see — that's keyed on the
//     browser `online` event, not the socket)
//   - teardown: `useWebSocket` closes on scope dispose (`autoClose` default), and
//     the bridge hosts this source in an effect scope, so teardown flows there
//
// Reconnect + heartbeat are VueUse built-ins; pass them straight through. The
// callbacks cannot return an effect Promise to the browser WebSocket API, so
// the adapter observes rejections to avoid unhandled-rejection noise; the
// bridge itself still exposes them through `error` / `onError`.

export interface NuxtWebSocketSourceOptions
  extends Pick<UseWebSocketOptions, 'protocols' | 'heartbeat' | 'autoReconnect'> {
  /**
   * Turn a raw frame (`string` | `Blob` | `ArrayBuffer`) into the value handed
   * to `push`. Defaults to JSON-parsing strings (non-JSON strings pass through
   * untouched — heartbeat/text frames are expected and not an error here; the
   * subscription's `schema` is where real validation belongs).
   */
  deserialize?: (data: unknown) => unknown
}

export function nuxtWebSocketSource(
  url: MaybeRefOrGetter<string>,
  options: NuxtWebSocketSourceOptions = {},
): (ctx: SubscriptionContextBase) => void {
  const { deserialize = defaultDeserialize, ...wsOptions } = options
  return (ctx) => {
    // First `onConnected` is the initial establishment; every later one is a
    // genuine reconnect, so only those trigger a re-sync.
    let connectedOnce = false
    useWebSocket(url, {
      ...wsOptions,
      // The adapter intentionally does not expose VueUse's `open()` control,
      // so allowing `immediate: false` would create a socket that can never be
      // opened. Establishment is owned by the subscription activation.
      immediate: true,
      onConnected: () => {
        if (connectedOnce) {
          observeBridgeEffect(ctx.resync())
        }
        else {
          connectedOnce = true
        }
      },
      onMessage: (_ws, event) => {
        let message: unknown
        try {
          message = deserialize(event.data)
        }
        catch (error) {
          observeBridgeEffect(ctx.fail(error))
          return
        }
        observeBridgeEffect(ctx.push(message))
      },
    })
    // No manual close: `useWebSocket` closes on scope dispose; the bridge runs
    // this source inside an effect scope, so a single close flows from teardown.
  }
}

function observeBridgeEffect(effect: Promise<void>): void {
  void effect.catch(() => {
    // The bridge already reports the effect failure through onError.
    return undefined
  })
}

function defaultDeserialize(data: unknown): unknown {
  if (typeof data !== 'string')
    return data
  try {
    return JSON.parse(data)
  }
  catch {
    // Expected: not every frame is JSON (pings, plain-text). Hand the raw
    // string onward and let the subscription's `schema` accept or reject it.
    return data
  }
}
