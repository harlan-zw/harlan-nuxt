import type { NitroCloudflareShape } from '../src/module'
import { loadNuxt } from '@nuxt/kit'
import { describe, expect, it } from 'vitest'
import cloudflareModule from '../src/module'

describe('nuxt integration', () => {
  it('applies defaults after every module and upgrades the existing cache mount', async () => {
    const nuxt = await loadNuxt({
      cwd: import.meta.dirname,
      dev: true,
      ready: false,
      overrides: {
        modules: [[cloudflareModule, { requiredSecrets: ['SESSION_PASSWORD'], sourceMaps: false }]],
        nitro: {
          storage: {
            cache: { driver: 'cloudflare-kv-binding', binding: 'CACHE' },
          },
        },
      },
    })

    await nuxt.ready()
    const nitro = nuxt.options.nitro as NitroCloudflareShape
    expect(nitro.cloudflare?.deployConfig).toBe(true)
    expect(nitro.cloudflare?.nodeCompat).toBe(true)
    expect(nitro.cloudflare?.wrangler).toMatchObject({
      cache: { enabled: true, cross_version_cache: false },
      compatibility_flags: ['nodejs_compat'],
      secrets: { required: ['SESSION_PASSWORD'] },
      upload_source_maps: false,
      version_metadata: { binding: 'CF_VERSION_METADATA' },
    })
    expect(nitro.storage?.cache?.driver).toMatch(/\/src\/storage\.ts$/)
    await nuxt.close()
  })

  it('blocks an HTML route rule that can populate Workers Cache', async () => {
    const nuxt = await loadNuxt({
      cwd: import.meta.dirname,
      dev: true,
      ready: false,
      overrides: {
        modules: [cloudflareModule],
      },
    })

    await nuxt.ready()
    await expect(nuxt.callHook('nitro:config', {
      routeRules: {
        '/docs/**': {
          headers: { 'cloudflare-cdn-cache-control': 'public, max-age=3600' },
        },
      },
    } as never)).rejects.toThrow('routeRules./docs/**.headers.cloudflare-cdn-cache-control')
    await nuxt.close()
  })
})
