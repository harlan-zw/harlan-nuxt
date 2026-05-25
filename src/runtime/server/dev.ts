import type { CloudflareQueue, QueueBindingsConfig } from './types'
import { resolveCloudflareQueueName } from './queue'

export interface DevQueueMessage {
  id?: string
  body: Record<string, unknown>
  attempts: number
  timestamp?: Date | number
  ack: () => void
  retry: (opts?: { delaySeconds?: number }) => void
}

export interface DevQueueBatch {
  queue: string
  messages: DevQueueMessage[]
  ackAll: () => void
  retryAll: (opts?: { delaySeconds?: number }) => void
}

export interface DevQueueHookPayload {
  batch: DevQueueBatch
  env: Record<string, unknown>
}

export interface DevQueueRuntime {
  env: Record<string, unknown>
  enqueue: (binding: string, body: Record<string, unknown>, opts?: { delaySeconds?: number, attempts?: number }) => void
  dispose: () => void
}

export interface DevQueueRuntimeOptions {
  queues: QueueBindingsConfig
  baseEnv?: Record<string, unknown>
  onBatch: (payload: DevQueueHookPayload) => Promise<void> | void
  onError?: (error: unknown) => void
  maxAttempts?: number
}

export function createDevQueueRuntime(opts: DevQueueRuntimeOptions): DevQueueRuntime {
  const env: Record<string, unknown> = { ...(opts.baseEnv ?? {}) }
  const bindingToLogical = new Map<string, string>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const maxAttempts = opts.maxAttempts ?? 10
  let disposed = false

  for (const [logicalName, config] of Object.entries(opts.queues)) {
    const binding = typeof config === 'string' ? config : config?.binding
    if (!binding)
      continue
    bindingToLogical.set(binding, logicalName)

    const queue: CloudflareQueue<Record<string, unknown>> = {
      async send(message, sendOpts) {
        enqueue(binding, message, { delaySeconds: sendOpts?.delaySeconds })
      },
      async sendBatch(messages, sendOpts) {
        for (const message of messages) {
          enqueue(binding, message.body, {
            delaySeconds: message.delaySeconds ?? sendOpts?.delaySeconds,
          })
        }
      },
    }
    env[binding] = queue
  }

  function enqueue(binding: string, body: Record<string, unknown>, eopts?: { delaySeconds?: number, attempts?: number, id?: string }) {
    if (disposed)
      return
    const logical = bindingToLogical.get(binding)
    if (!logical)
      return
    const cfQueueName = resolveCloudflareQueueName(opts.queues, logical)
    const attempts = (eopts?.attempts ?? 0) + 1
    const delayMs = Math.max(0, (eopts?.delaySeconds ?? 0) * 1000)
    const id = eopts?.id ?? (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`)

    const fire = () => {
      let settled = false
      const message: DevQueueMessage = {
        id,
        body,
        attempts,
        timestamp: new Date(),
        ack() {
          settled = true
        },
        retry(retryOpts) {
          if (settled)
            return
          settled = true
          if (attempts >= maxAttempts)
            return
          enqueue(binding, body, { delaySeconds: retryOpts?.delaySeconds, attempts, id })
        },
      }
      const batch: DevQueueBatch = {
        queue: cfQueueName,
        messages: [message],
        ackAll() {
          settled = true
        },
        retryAll(retryOpts) {
          if (settled)
            return
          settled = true
          if (attempts >= maxAttempts)
            return
          enqueue(binding, body, { delaySeconds: retryOpts?.delaySeconds, attempts, id })
        },
      }
      Promise.resolve()
        .then(() => opts.onBatch({ batch, env }))
        .catch(error => opts.onError?.(error))
    }

    if (delayMs === 0) {
      queueMicrotask(fire)
      return
    }
    const timer = setTimeout(() => {
      timers.delete(timer)
      fire()
    }, delayMs)
    timers.add(timer)
  }

  return {
    env,
    enqueue,
    dispose() {
      disposed = true
      for (const timer of timers)
        clearTimeout(timer)
      timers.clear()
    },
  }
}
