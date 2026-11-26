import type { Fast404RuntimeConfig } from '../utils/fast-404'
import { defineEventHandler } from 'nuxt/server'
import { useRuntimeConfig } from '#nuxt-cloudflare/nitro'
import { classifyFast404Request, createFast404Response } from '../utils/fast-404'

export default defineEventHandler((event) => {
  const config = useRuntimeConfig() as {
    nuxtCloudflare?: { fast404?: Fast404RuntimeConfig }
  }
  const fast404 = config.nuxtCloudflare?.fast404
  if (!fast404)
    return

  const decision = classifyFast404Request(event.url.pathname, event.req.method, fast404)
  if (decision._tag === 'not-found')
    return createFast404Response(event.req.method, fast404.edgeCacheTtlSeconds)
})
