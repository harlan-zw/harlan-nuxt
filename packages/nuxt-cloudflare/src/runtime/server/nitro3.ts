import type { NitroAppPlugin } from 'nitro/types'
import { definePlugin } from 'nitro'
import { useRequest } from 'nitro/context'

export { useRuntimeConfig } from 'nuxt/server'

/** Registers a plugin that receives the Nitro app itself, not the hook-adapted copy. */
export const defineNitroAppPlugin: (setup: NitroAppPlugin) => NitroAppPlugin = definePlugin

export function defineNitroPlugin(setup: NitroAppPlugin) {
  return definePlugin((app) => {
    const hooks = app.hooks
    const hook = hooks.hook.bind(hooks)
    const adapted = Object.create(hooks) as typeof hooks
    adapted.hook = ((name: string, handler: (...args: any[]) => unknown) => {
      if (name === 'beforeResponse') {
        return hook('response', async (response, event) => {
          await handler(new Proxy(event, {
            get(target, key) {
              if (key === 'res')
                return { status: response.status, headers: response.headers }
              return Reflect.get(target, key, target)
            },
          }))
        })
      }
      return hook(name as never, handler as never)
    }) as typeof hooks.hook
    return setup({ ...app, hooks: adapted })
  })
}

/**
 * The request Nitro serves now, from its async context. Undefined outside a
 * request, or when `experimental.asyncContext` is off.
 */
export function currentRequest(): Request | undefined {
  try {
    return useRequest()
  }
  catch {
    // `useRequest` throws outside a request context. The caller then keeps its own lifetime.
    return undefined
  }
}
