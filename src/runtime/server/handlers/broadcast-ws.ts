// @ts-expect-error - nitropack/runtime is resolved at build time inside Nuxt
import { useNitroApp } from 'nitropack/runtime'
import {
  CF_JOBS_BROADCAST_SYSTEM_CHANNEL,
  cfJobsBroadcastTopic,
  parseCfJobsBroadcastCommand,
} from '../broadcast'

interface CfJobsWebSocketPeer {
  id: string
  topics: Set<string>
  subscribe: (topic: string) => void
  unsubscribe: (topic: string) => void
  send: (data: unknown, opts?: { compress?: boolean }) => void
  close: (code?: number, reason?: string) => void
}

interface CfJobsWebSocketMessage {
  text: () => string
}

interface CfJobsWebSocketHooks {
  open: (peer: CfJobsWebSocketPeer) => void | Promise<void>
  message: (peer: CfJobsWebSocketPeer, message: CfJobsWebSocketMessage) => void | Promise<void>
  close: (peer: CfJobsWebSocketPeer) => void | Promise<void>
  error: (peer: CfJobsWebSocketPeer) => void | Promise<void>
}

interface CfJobsBroadcastAuthorizePayload {
  peer: CfJobsWebSocketPeer
  channel: string
  event: 'subscribe'
  authorized: boolean
}

interface CfJobsBroadcastNitroApp {
  hooks: {
    callHook: (name: string, payload: unknown) => Promise<unknown>
  }
}

const hooks: CfJobsWebSocketHooks = {
  async open(peer) {
    sendSystem(peer, 'ready', { id: peer.id })
    await callHook('cf-jobs:broadcast:open', { id: peer.id })
  },
  async message(peer, message) {
    const command = parseCfJobsBroadcastCommand(message.text())
    if (!command) {
      sendSystem(peer, 'error', { reason: 'invalid-message' })
      return
    }

    if (command.event === 'ping') {
      sendSystem(peer, 'pong', {})
      return
    }

    const subscribed: string[] = []
    const rejected: string[] = []
    for (const channel of command.channels) {
      if (command.event === 'subscribe' && !(await authorize(peer, channel))) {
        rejected.push(channel)
        continue
      }
      const topic = cfJobsBroadcastTopic(channel)
      if (command.event === 'subscribe') {
        peer.subscribe(topic)
        subscribed.push(channel)
      }
      else {
        peer.unsubscribe(topic)
        subscribed.push(channel)
      }
    }

    sendSystem(peer, command.event === 'subscribe' ? 'subscribed' : 'unsubscribed', {
      channels: subscribed,
      rejected,
    })
  },
  async close(peer) {
    for (const topic of peer.topics)
      peer.unsubscribe(topic)
    await callHook('cf-jobs:broadcast:close', { id: peer.id })
  },
  error(peer) {
    peer.close()
  },
}

function handler(): Response {
  return Object.assign(new Response('WebSocket upgrade is required.', { status: 426 }), { crossws: hooks })
}

Object.assign(handler, {
  __is_handler__: true,
  __websocket__: hooks,
})

export default handler

async function authorize(peer: CfJobsWebSocketPeer, channel: string): Promise<boolean> {
  const payload: CfJobsBroadcastAuthorizePayload = {
    peer,
    channel,
    event: 'subscribe',
    authorized: true,
  }
  await callHook('cf-jobs:broadcast:authorize', payload)
  return payload.authorized !== false
}

function sendSystem(peer: CfJobsWebSocketPeer, event: string, data: unknown): void {
  peer.send(JSON.stringify({
    channel: CF_JOBS_BROADCAST_SYSTEM_CHANNEL,
    event,
    data,
  }))
}

function callHook(name: string, payload: unknown): Promise<unknown> {
  return (useNitroApp() as unknown as CfJobsBroadcastNitroApp).hooks.callHook(name, payload)
}
