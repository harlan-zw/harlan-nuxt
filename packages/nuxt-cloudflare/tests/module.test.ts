import type { Nuxt } from '@nuxt/schema'
import type { NitroCloudflareShape } from '../src/module'
import { describe, expect, it } from 'vitest'
import { configureNitroCloudflare, setupCloudflareModule } from '../src/module'

function nuxtWithCapturedHooks(dev: boolean, serverSourceMaps = false): { hooks: string[], nuxt: Nuxt } {
  const hooks: string[] = []
  const nuxt = {
    hook(name: string) {
      hooks.push(name)
    },
    options: { dev, nitro: {}, sourcemap: { server: serverSourceMaps } },
  } as unknown as Nuxt
  return { hooks, nuxt }
}

describe('configureNitroCloudflare', () => {
  it('upgrades only the Nitro cache mount from raw Cloudflare KV', () => {
    const nitro: NitroCloudflareShape = {
      storage: {
        cache: { driver: 'cloudflare-kv-binding', binding: 'CACHE' },
        kv: { driver: 'cloudflare-kv-binding', binding: 'KV' },
      },
    }

    configureNitroCloudflare(nitro, {})

    expect(nitro.storage?.cache).toMatchObject({ binding: 'CACHE', defaultTtl: 2_592_000 })
    expect(nitro.storage?.cache?.driver).toMatch(/\/src\/storage\.ts$/)
    expect(nitro.storage?.kv).toEqual({ driver: 'cloudflare-kv-binding', binding: 'KV' })
  })

  it('preserves the durable preset and explicit source-map opt-out', () => {
    const nitro: NitroCloudflareShape = {
      preset: 'cloudflare-durable',
      sourceMap: false,
      cloudflare: { wrangler: {} },
    }

    configureNitroCloudflare(nitro, {})

    expect(nitro.preset).toBe('cloudflare-durable')
    expect(nitro.cloudflare?.wrangler?.upload_source_maps).toBe(false)
  })
})

describe('setupCloudflareModule', () => {
  it('does not register the production Wrangler audit during development', () => {
    const { hooks, nuxt } = nuxtWithCapturedHooks(true)

    setupCloudflareModule({ enabled: true }, nuxt)

    expect(hooks).toEqual(['modules:done'])
  })

  it('registers the production Wrangler audit for builds', () => {
    const { hooks, nuxt } = nuxtWithCapturedHooks(false)

    setupCloudflareModule({ enabled: true }, nuxt)

    expect(hooks).toEqual(['modules:done', 'nitro:init'])
  })

  it('uses Nuxt server source maps as the upload policy', () => {
    const disabled = nuxtWithCapturedHooks(false, false)
    const enabled = nuxtWithCapturedHooks(false, true)

    setupCloudflareModule({ enabled: true }, disabled.nuxt)
    setupCloudflareModule({ enabled: true }, enabled.nuxt)

    expect(disabled.nuxt.options.nitro.cloudflare?.wrangler?.upload_source_maps).toBe(false)
    expect(enabled.nuxt.options.nitro.cloudflare?.wrangler?.upload_source_maps).toBe(true)
  })
})
