import type { RuntimeApp } from './nitro-types'
import { defineNitroPlugin as definePlugin, useNitroApp as useApp } from 'nitropack/runtime'

function runtimeApp(app: ReturnType<typeof useApp>): RuntimeApp {
  return { hooks: {
    hook(name, handler) {
      if (name === 'response')
        app.hooks.hook('afterResponse', (event, response) => handler(response, event))
      else
        app.hooks.hook(name as never, handler as never)
    },
    // Schedule every sink before running one that can throw synchronously.
    callHookParallel: async (name, ...args) => {
      await app.hooks.callHookWith(
        (callbacks: Array<(...args: any[]) => unknown>, args: any[]) => Promise.all(callbacks.map(callback => Promise.resolve().then(() => callback(...args)))),
        name as never,
        ...args as never,
      )
    },
    callHook: app.hooks.callHook.bind(app.hooks) as RuntimeApp['hooks']['callHook'],
  } }
}
export function defineNitroPlugin(setup: (app: RuntimeApp) => void) {
  return definePlugin(app => setup(runtimeApp(app)))
}
export function useNitroApp() {
  return runtimeApp(useApp())
}
