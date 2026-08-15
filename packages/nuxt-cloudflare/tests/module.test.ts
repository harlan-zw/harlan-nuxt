import type { Nuxt } from '@nuxt/schema'
import type { NitroCloudflareShape } from '../src/module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureNitroCloudflare, findPopulatedRuntimeSecretPaths, setupCloudflareModule } from '../src/module'

function nuxtWithCapturedHooks(dev: boolean, serverSourceMaps = false): {
  callbacks: Record<string, () => unknown>
  hooks: string[]
  nuxt: Nuxt
} {
  const callbacks: Record<string, () => unknown> = {}
  const hooks: string[] = []
  const nuxt = {
    hook(name: string, callback: () => unknown) {
      hooks.push(name)
      callbacks[name] = callback
    },
    options: { dev, nitro: {}, runtimeConfig: {}, sourcemap: { server: serverSourceMaps } },
  } as unknown as Nuxt
  return { callbacks, hooks, nuxt }
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

  it('enables version-isolated Workers Caching by default', () => {
    const nitro: NitroCloudflareShape = {}

    configureNitroCloudflare(nitro, {})

    expect(nitro.cloudflare?.wrangler?.cache).toEqual({
      enabled: true,
      cross_version_cache: false,
    })
    expect(nitro.plugins).toEqual([
      expect.stringMatching(/\/runtime\/server\/plugins\/workers-cache\.ts$/),
    ])
  })

  it('enables Smart Placement by default', () => {
    const nitro: NitroCloudflareShape = {}

    configureNitroCloudflare(nitro, {})

    expect(nitro.cloudflare?.wrangler?.placement).toEqual({ mode: 'smart' })
  })

  it('supports version-isolated Workers Caching as an explicit policy', () => {
    const nitro: NitroCloudflareShape = {}

    configureNitroCloudflare(nitro, {
      workersCache: { _tag: 'enabled', crossVersion: false },
    })

    expect(nitro.cloudflare?.wrangler?.cache).toEqual({
      enabled: true,
      cross_version_cache: false,
    })
  })

  it('supports an explicit Workers Caching opt-out', () => {
    const nitro: NitroCloudflareShape = {}

    configureNitroCloudflare(nitro, {
      workersCache: { _tag: 'disabled' },
    })

    expect(nitro.cloudflare?.wrangler?.cache).toEqual({
      enabled: false,
      cross_version_cache: false,
    })
    expect(nitro.plugins).toBeUndefined()
  })
})

describe('setupCloudflareModule', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('finds build environment secrets copied into runtime config without returning their values', () => {
    const config = {
      generated: { runtimeSyncSecret: 'generated-at-build' },
      oauth: { clientSecret: 'oauth-sentinel' },
      public: { apiKey: 'intentionally-public' },
      resendApiKey: 'resend-sentinel',
      session: { password: '' },
    }

    const paths = findPopulatedRuntimeSecretPaths(config, {
      NUXT_OAUTH_CLIENT_SECRET: 'oauth-sentinel',
      NUXT_RESEND_API_KEY: 'resend-sentinel',
    })

    expect(paths).toEqual(['oauth.clientSecret', 'resendApiKey'])
    expect(JSON.stringify(paths)).not.toContain('sentinel')
  })

  it('permits Nuxt Scripts proxy signing required during module setup', () => {
    expect(findPopulatedRuntimeSecretPaths({
      'nuxt-scripts': { proxySecret: 'proxy-sentinel' },
    }, {
      NUXT_SCRIPTS_PROXY_SECRET: 'proxy-sentinel',
    })).toEqual([])
  })

  it('blocks a production build with a populated runtime secret default', () => {
    const { callbacks, nuxt } = nuxtWithCapturedHooks(false)
    Object.assign(nuxt.options.runtimeConfig, { oauth: { clientSecret: 'oauth-sentinel' } })
    vi.stubEnv('NUXT_OAUTH_CLIENT_SECRET', 'oauth-sentinel')

    setupCloudflareModule({ bindingTypes: false, enabled: true }, nuxt)

    expect(callbacks['modules:done']).toThrow('oauth.clientSecret')
    expect(callbacks['modules:done']).not.toThrow('oauth-sentinel')
  })

  it('does not register the production Wrangler audit during development', () => {
    const { hooks, nuxt } = nuxtWithCapturedHooks(true)

    setupCloudflareModule({ bindingTypes: false, enabled: true }, nuxt)

    expect(hooks).toEqual(['modules:done', 'nitro:config'])
  })

  it('registers the production Wrangler audit for builds', () => {
    const { hooks, nuxt } = nuxtWithCapturedHooks(false)

    setupCloudflareModule({ bindingTypes: false, enabled: true }, nuxt)

    expect(hooks).toEqual(['modules:done', 'nitro:config', 'nitro:init'])
  })

  it('uses Nuxt server source maps as the upload policy', () => {
    const disabled = nuxtWithCapturedHooks(false, false)
    const enabled = nuxtWithCapturedHooks(false, true)

    setupCloudflareModule({ bindingTypes: false, enabled: true }, disabled.nuxt)
    setupCloudflareModule({ bindingTypes: false, enabled: true }, enabled.nuxt)

    expect(disabled.nuxt.options.nitro.cloudflare?.wrangler?.upload_source_maps).toBe(false)
    expect(enabled.nuxt.options.nitro.cloudflare?.wrangler?.upload_source_maps).toBe(true)
  })
})

describe('workerd console module', () => {
  it('aliases the console module away from node:console', () => {
    const nitro: NitroCloudflareShape = {}

    configureNitroCloudflare(nitro, {})

    expect(nitro.alias?.console).toMatch(/workerd-console\.(?:mjs|js)$/)
    expect(nitro.alias?.['node:console']).toBe(nitro.alias?.console)
  })

  it('keeps a console alias the app already set', () => {
    const nitro: NitroCloudflareShape = {
      alias: { 'console': '/app/my-console.mjs', 'node:console': '/app/my-console.mjs' },
    }

    configureNitroCloudflare(nitro, {})

    expect(nitro.alias?.console).toBe('/app/my-console.mjs')
    expect(nitro.alias?.['node:console']).toBe('/app/my-console.mjs')
  })

  it('leaves unrelated aliases alone', () => {
    const nitro: NitroCloudflareShape = { alias: { sharp: 'unenv/mock/empty' } }

    configureNitroCloudflare(nitro, {})

    expect(nitro.alias?.sharp).toBe('unenv/mock/empty')
  })
})
