// @ts-expect-error - nitropack/runtime is resolved at build time inside Nuxt
import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime'
import { createDevQueueRuntime } from '../dev'

interface NitroAppLike {
  hooks: {
    hook: (name: string, handler: (...args: any[]) => any) => void
    callHook: (name: string, payload: unknown) => Promise<unknown>
  }
}

interface RequestEventLike {
  context: {
    cloudflare?: { env?: Record<string, unknown> } & Record<string, unknown>
  }
}

export default defineNitroPlugin((nitroApp: NitroAppLike) => {
  const config = useRuntimeConfig().cfJobs as { queues?: Record<string, string | { binding: string }> } | undefined
  const queues = config?.queues ?? {}
  if (!Object.keys(queues).length)
    return

  const runtime = createDevQueueRuntime({
    queues,
    onBatch: async (payload) => {
      await nitroApp.hooks.callHook('cloudflare:queue', payload)
    },
    onError(error) {
      console.error('[nuxt-cf-jobs] dev queue error:', error)
    },
  })

  nitroApp.hooks.hook('request', (event: RequestEventLike) => {
    const existing = event.context.cloudflare?.env
    event.context.cloudflare = {
      ...(event.context.cloudflare ?? {}),
      env: existing ? { ...runtime.env, ...existing } : runtime.env,
    }
  })

  nitroApp.hooks.hook('close', () => runtime.dispose())
})
