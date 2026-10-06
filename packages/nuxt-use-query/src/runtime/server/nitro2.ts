import type { RuntimeApp } from './nitro-types'
import { defineNitroPlugin as nativedefineNitroPlugin, useNitroApp as nativeuseNitroApp, useEvent, useRuntimeConfig } from 'nitropack/runtime'

function runtimeApp(app: ReturnType<typeof nativeuseNitroApp>): RuntimeApp {
  return { _tag: 'Nitro2', hooks: {
    hook(name, handler) {
      if (name === 'response')
        app.hooks.hook('afterResponse', (event, response) => handler(response, event))
      else
        app.hooks.hook(name as never, handler as never)
    },
    callHook: (name, ...args) => app.hooks.callHook(name as never, ...args as never),
  } }
}
export function defineNitroPlugin(setup: (app: RuntimeApp) => void) {
  return nativedefineNitroPlugin(app => setup(runtimeApp(app)))
}
export function useNitroApp() {
  return runtimeApp(nativeuseNitroApp())
}
export { useEvent, useRuntimeConfig }
