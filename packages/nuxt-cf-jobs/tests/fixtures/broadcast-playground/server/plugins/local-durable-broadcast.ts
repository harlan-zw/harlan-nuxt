import { defineNitroPlugin } from 'nitropack/runtime'

interface PeerLike {
  id: string
  topics: Set<string>
  send: (data: unknown, opts?: { compress?: boolean }) => void
}

interface WebSocketHooks {
  open?: (peer: PeerLike) => void | Promise<void>
  close?: (peer: PeerLike, details: { code?: number, reason?: string }) => void | Promise<void>
}

interface H3WebSocketOptions {
  hooks?: WebSocketHooks
}

interface LocalDurableNamespace {
  idFromName: (name: string) => string
  get: (id: string) => {
    publish: (topic: string, data: unknown, opts?: { compress?: boolean }) => Promise<void>
  }
}

interface BroadcastPlaygroundGlobal {
  __cfJobsBroadcastPlaygroundEnv?: { $DurableObject: LocalDurableNamespace }
}

export default defineNitroPlugin((nitroApp) => {
  const peers = new Set<PeerLike>()
  const h3App = (nitroApp as { h3App: { readonly websocket?: H3WebSocketOptions } }).h3App
  const websocket = h3App.websocket
  if (!websocket)
    throw new Error('Nitro websocket support is not enabled')

  const existingHooks = websocket.hooks ?? {}

  websocket.hooks = {
    ...existingHooks,
    async open(peer) {
      peers.add(peer)
      await existingHooks.open?.(peer)
    },
    async close(peer, details) {
      peers.delete(peer)
      await existingHooks.close?.(peer, details)
    },
  }

  const runtimeGlobal = globalThis as typeof globalThis & BroadcastPlaygroundGlobal
  runtimeGlobal.__cfJobsBroadcastPlaygroundEnv = {
    $DurableObject: {
      idFromName: name => name,
      get: () => ({
        async publish(topic, data, opts) {
          for (const peer of peers) {
            if (peer.topics.has(topic))
              peer.send(data, opts)
          }
        },
      }),
    },
  }

  nitroApp.hooks.hook('cf-jobs:broadcast:authorize', (ctx: { channel: string, authorized: boolean }) => {
    if (ctx.channel === 'site:blocked')
      ctx.authorized = false
  })
})
