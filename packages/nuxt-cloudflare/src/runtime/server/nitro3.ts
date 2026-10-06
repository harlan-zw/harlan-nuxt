import type { NitroAppPlugin } from 'nitro/types'
import { definePlugin } from 'nitro'

export { useRuntimeConfig } from 'nuxt/server'

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
