import type { WranglerConfigInput } from '@harlan-zw/nuxt-cloudflare/wrangler'
import type { NitroAppPlugin } from 'nitro/types'
import type * as Wrangler from 'wrangler'
import { randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { setCloudflareBindings } from '@harlan-zw/nuxt-cloudflare/bindings'
import { readWranglerConfigFile } from '@harlan-zw/nuxt-cloudflare/wrangler'

interface DevProxyOptions {
  rootDir: string
  configPath?: string
  persist: false | { path: string }
  wrangler?: WranglerConfigInput
}

// Match Nitro's Wrangler merge: inline values win, arrays are appended.
function mergeConfig(primary: unknown, fallback: unknown): unknown {
  if (primary === undefined || primary === null)
    return fallback
  if (Array.isArray(primary) && Array.isArray(fallback))
    return [...primary, ...fallback]
  if (typeof primary !== 'object' || Array.isArray(primary) || !fallback || typeof fallback !== 'object' || Array.isArray(fallback))
    return primary
  const merged = { ...primary } as Record<string, unknown>
  for (const [key, value] of Object.entries(fallback))
    merged[key] = mergeConfig(merged[key], value)
  return merged
}

export async function createDevProxy({ rootDir, wrangler, ...options }: DevProxyOptions): Promise<NitroAppPlugin> {
  // Load the app's Wrangler without bundling its Node runtime into Nitro.
  const requireFromProject = createRequire(`${rootDir}/package.json`)
  const { getPlatformProxy } = requireFromProject('wrangler') as typeof Wrangler
  let proxy: Wrangler.PlatformProxy
  const authored = wrangler && options.configPath ? readWranglerConfigFile(options.configPath) : undefined
  if (wrangler && (!authored || authored._tag === 'loaded')) {
    // Keep relative paths and local variable files relative to the authored config.
    const configPath = join(options.configPath ? dirname(options.configPath) : rootDir, `.nuxt-cloudflare-${randomUUID()}.json`)
    await writeFile(configPath, JSON.stringify(mergeConfig(wrangler, authored?.config ?? {})), { flag: 'wx', mode: 0o600 })
    try {
      proxy = await getPlatformProxy({ ...options, configPath, remoteBindings: false })
    }
    finally {
      await unlink(configPath)
    }
  }
  else {
    // Wrangler reports missing or invalid explicit configs with its original error.
    proxy = await getPlatformProxy({ ...options, remoteBindings: false })
  }
  const { cf, ctx, dispose, env } = proxy
  setCloudflareBindings(env)

  return (app) => {
    app.hooks.hook('request', (event) => {
      event.context.cf = cf
      event.context.cloudflare = { env, context: ctx, request: event.req }
      event.context.waitUntil = ctx.waitUntil.bind(ctx)
    })
    app.hooks.hook('close', dispose)
  }
}
