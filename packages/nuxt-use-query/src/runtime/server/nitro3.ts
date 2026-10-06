import type { RuntimeApp } from './nitro-types'
import { definePlugin } from 'nitro'
import { useNitroApp as useApp, useNitroHooks } from 'nitro/app'
import { useRequest } from 'nitro/context'
import { useRuntimeConfig } from 'nuxt/server'

function runtimeApp(): RuntimeApp {
  const hooks = useNitroHooks()
  const app = useApp()
  const fetch = app.fetch.bind(app)
  return { _tag: 'Nitro3', fetch: async request => fetch(request), setFetch: (fetch) => {
    app.fetch = fetch
  }, hooks: {
    hook(name, handler) {
      if (name === 'response')
        hooks.hook('response', (response, event) => handler(response, requestEvent(event.req)))
      else
        hooks.hook(name as never, handler as never)
    },
    callHook: async (name, ...args) => { await hooks.callHook(name as never, ...args as never) },
  } }
}
export function defineNitroPlugin(setup: (app: RuntimeApp) => void) {
  return definePlugin(() => setup(runtimeApp()))
}
export function useNitroApp(): RuntimeApp {
  return runtimeApp()
}
export { useRuntimeConfig }
function requestEvent(req: ReturnType<typeof useRequest>) {
  return { req, context: req.context, path: new URL(req.url).pathname, method: req.method }
}
export function useEvent() {
  return requestEvent(useRequest())
}
