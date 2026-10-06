import type { NitroAppPlugin } from 'nitropack/types'
import { defineNitroPlugin as definePlugin } from 'nitropack/runtime'

export { useRuntimeConfig } from 'nitropack/runtime'

export function defineNitroPlugin(setup: NitroAppPlugin) {
  return definePlugin((app) => {
    const hooks = app.hooks
    const hook = hooks.hook.bind(hooks)
    const adapted = Object.create(hooks) as typeof hooks
    adapted.hook = ((name: string, handler: (...args: any[]) => unknown) => {
      if (name === 'beforeResponse') {
        return hook('beforeResponse', async (event, result) => {
          if (!(result.body instanceof Response)) {
            await handler(event, result)
            return
          }
          const response = result.body
          const headers = new Proxy(response.headers, {
            get(target, key) {
              if (key === 'get') {
                return (name: string) => {
                  const value = event.node.res.getHeader(name)
                  return target.get(name) ?? (value === undefined ? null : String(value))
                }
              }
              if (key === 'set') {
                return (name: string, value: string) => {
                  target.set(name, value)
                  event.node.res.setHeader(name, value)
                }
              }
              const value = Reflect.get(target, key, target)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
          const requestHeaders = new Headers()
          for (const [name, value] of Object.entries(event.node.req.headers)) {
            if (value !== undefined)
              requestHeaders.set(name, Array.isArray(value) ? value.join(', ') : value)
          }
          await handler(new Proxy(event, {
            has(target, key) {
              return key === 'res' || key === 'req' || Reflect.has(target, key)
            },
            get(target, key) {
              if (key === 'res')
                return { status: response.status, headers }
              if (key === 'req')
                return { headers: requestHeaders }
              return Reflect.get(target, key, target)
            },
          }), result)
        })
      }
      return hook(name as never, handler as never)
    }) as typeof hooks.hook
    return setup({ ...app, hooks: adapted })
  })
}
