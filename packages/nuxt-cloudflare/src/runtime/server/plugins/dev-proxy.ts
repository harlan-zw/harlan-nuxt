import type { NitroAppPlugin } from 'nitro/types'
import type * as Wrangler from 'wrangler'
import { createRequire } from 'node:module'
import { setCloudflareBindings } from '@harlan-zw/nuxt-cloudflare/bindings'

interface DevProxyOptions {
  rootDir: string
  configPath?: string
  persist: false | { path: string }
}

export function createDevProxy({ rootDir, ...options }: DevProxyOptions): NitroAppPlugin {
  return async (app) => {
    // Load the app's Wrangler without bundling its Node runtime into Nitro.
    const requireFromProject = createRequire(`${rootDir}/package.json`)
    const { getPlatformProxy } = requireFromProject('wrangler') as typeof Wrangler
    const { cf, ctx, dispose, env } = await getPlatformProxy({ ...options, remoteBindings: false })
    setCloudflareBindings(env)

    app.hooks.hook('request', (event) => {
      event.context.cf = cf
      event.context.cloudflare = { env, context: ctx, request: event.req }
      event.context.waitUntil = ctx.waitUntil.bind(ctx)
    })

    app.hooks.hook('close', dispose)
  }
}
