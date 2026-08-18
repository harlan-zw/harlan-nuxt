import type { NitroCloudflareShape } from '../src/module'
import { loadNuxt, writeTypes } from '@nuxt/kit'
import { describe, expect, it } from 'vitest'
import cloudflareModule from '../src/module'

describe('nuxt integration', () => {
  it('keeps binding runtime types out of Vue global type files', async () => {
    const nuxt = await loadNuxt({
      cwd: import.meta.dirname,
      dev: true,
      ready: false,
      overrides: {
        modules: [cloudflareModule],
      },
    })

    try {
      await nuxt.ready()
      const bindingTypePath = (path: string | undefined) => path?.endsWith('/types/cloudflare-bindings.d.ts')
      const globalTypeFiles = nuxt.options.vite.vue?.script?.globalTypeFiles ?? []
      const nuxtTypeReferences: string[] = []
      nuxt.hook('prepare:types', ({ references }) => {
        nuxtTypeReferences.push(...references.flatMap(reference => 'path' in reference ? reference.path : []))
      })

      expect(globalTypeFiles.some(bindingTypePath)).toBe(false)

      await writeTypes(nuxt)
      expect(nuxtTypeReferences.some(bindingTypePath)).toBe(true)

      const nitroTypeReferences: Array<{ path?: string }> = []
      await nuxt.callHook('nitro:prepare:types', { references: nitroTypeReferences } as never)
      expect(nitroTypeReferences.some(reference => bindingTypePath(reference.path))).toBe(true)
    }
    finally {
      await nuxt.close()
    }
  })

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
      compatibility_flags: ['nodejs_compat', 'no_nodejs_compat_v2'],
      secrets: { required: ['SESSION_PASSWORD'] },
      upload_source_maps: false,
      version_metadata: { binding: 'CF_VERSION_METADATA' },
    })
    expect(nitro.storage?.cache?.driver).toMatch(/\/src\/storage\.ts$/)
    await nuxt.close()
  })

  it('warns for ambiguous cache rules and blocks explicit HTML cache rules', async () => {
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
      virtual: {},
      routeRules: {
        '/docs/**': {
          headers: { 'cloudflare-cdn-cache-control': 'public, max-age=3600' },
        },
      },
    } as never)).resolves.toBeUndefined()
    await expect(nuxt.callHook('nitro:config', {
      virtual: {},
      routeRules: {
        '/docs/**': {
          prerender: true,
          headers: { 'cloudflare-cdn-cache-control': 'public, max-age=3600' },
        },
      },
    } as never)).rejects.toThrow('routeRules./docs/**.headers.cloudflare-cdn-cache-control')
    await nuxt.close()
  })
})
