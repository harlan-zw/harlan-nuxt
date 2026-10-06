import type { NitroRuntimeHooks } from 'nitro/types'
import type { RuntimeApp } from './nitro-types'
import { definePlugin } from 'nitro'
import { useNitroHooks } from 'nitro/app'
import { createParallelHookCaller } from './parallel-hooks'

const DISPATCH = Symbol.for('@harlan-zw/nuxt-wide-events/dispatch')

function runtimeApp(): RuntimeApp {
  const hooks = useNitroHooks()
  const state = hooks as typeof hooks & { [DISPATCH]?: ReturnType<typeof createParallelHookCaller> }
  const dispatch = state[DISPATCH] ??= createParallelHookCaller(hooks as Parameters<typeof createParallelHookCaller>[0], 'wide-events:emit')
  return { hooks: {
    hook(name, handler) {
      if (name === 'request')
        hooks.hook('request', event => handler(requestEvent(event)))
      else if (name === 'response')
        hooks.hook('response', (response, event) => handler(response, requestEvent(event)))
      else if (name === 'error')
        hooks.hook('error', (error, context) => handler(error, { ...context, event: context.event && requestEvent(context.event) }))
      else
        hooks.hook(name as never, handler as never)
    },
    callHookParallel: async (name, ...args) => {
      if (name !== 'wide-events:emit')
        throw new Error('Parallel dispatch supports only wide-events:emit.')
      await dispatch(...args)
    },
    callHook: async (name, ...args) => { await hooks.callHook(name as never, ...args as never) },
  } }
}

function requestEvent(event: Parameters<NitroRuntimeHooks['request']>[0]) {
  const url = new URL(event.req.url)
  const context = new Proxy(event.req.context ??= {}, {
    get(target, key) {
      const value = Reflect.get(target, key, target)
      if (key === 'matchedRoute' && value)
        return { ...value, path: value.route }
      return value
    },
  })
  return new Proxy(event, {
    get(target, key) {
      if (key === 'path')
        return `${url.pathname}${url.search}`
      if (key === 'method')
        return event.req.method
      if (key === 'context')
        return context
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
export function defineNitroPlugin(setup: (app: RuntimeApp) => void) {
  return definePlugin(() => setup(runtimeApp()))
}
export function useNitroApp(): RuntimeApp {
  return runtimeApp()
}
