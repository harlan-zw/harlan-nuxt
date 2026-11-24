import type { Nuxt, NuxtHooks } from '@nuxt/schema'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { buildNuxt, useNitro } from '@nuxt/kit'
import { build as buildNitro, createNitro } from 'nitro/builder'
import { loadNuxt } from 'nuxt'
import { afterEach, describe, expect, it } from 'vitest'
import sponsorsModule from '../src/module'

const PLACEHOLDER = 'inertSponsorsTokenPlaceholder9q4z'

const touchedEnv = new Set<string>()
const openNuxts: Nuxt[] = []
const roots: string[] = []
const openNitros: Awaited<ReturnType<typeof createNitro>>[] = []

afterEach(async () => {
  for (const name of touchedEnv)
    delete process.env[name]
  touchedEnv.clear()
  await Promise.all(openNitros.splice(0).map(nitro => nitro.close()))
  await Promise.all(openNuxts.splice(0).map(nuxt => nuxt.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Runs the module the way a site build does, with the token in the build env. */
async function loadSite(input: {
  env: Record<string, string>
  options?: Record<string, unknown>
  runtimeConfig?: Record<string, unknown>
  hooks?: Partial<NuxtHooks>
}): Promise<Nuxt> {
  for (const [name, value] of Object.entries(input.env)) {
    process.env[name] = value
    touchedEnv.add(name)
  }
  const cwd = await mkdtemp(join(tmpdir(), 'nuxt-github-sponsors-'))
  roots.push(cwd)
  await symlink(new URL('../node_modules', import.meta.url), join(cwd, 'node_modules'), 'dir')
  const nuxt = await loadNuxt({
    cwd,
    ready: false,
    overrides: {
      dev: false,
      devtools: { enabled: false },
      runtimeConfig: input.runtimeConfig,
      modules: [async (_options, nuxt) => {
        await sponsorsModule({ login: 'harlan-zw', ...input.options }, nuxt)
      }],
      hooks: input.hooks,
    },
  })
  openNuxts.push(nuxt)
  await nuxt.ready()
  return nuxt
}

describe('build-time token boundary', () => {
  it.each([
    ['the default env name', 'NUXT_GITHUB_SPONSORS_TOKEN', {}],
    ['an aliased env name', 'NUXT_GITHUB_AUTH_TOKEN', { tokenEnv: 'NUXT_GITHUB_AUTH_TOKEN' }],
  ])('keeps a token in %s out of the runtime config Nitro serializes', async (_label, envName, options) => {
    const nuxt = await loadSite({ env: { [envName]: PLACEHOLDER }, options })
    expect(JSON.stringify(nuxt.options.runtimeConfig)).not.toContain(PLACEHOLDER)
    expect(JSON.stringify(nuxt.runWithContext(() => useNitro().options.runtimeConfig))).not.toContain(PLACEHOLDER)
  })

  it('still prerenders the route when the build env has the token', async () => {
    const nuxt = await loadSite({ env: { NUXT_GITHUB_SPONSORS_TOKEN: PLACEHOLDER } })
    expect(nuxt.options.nitro.routeRules?.['/api/github-sponsors']).toMatchObject({ prerender: true })
  })

  it('refuses a token a site writes into runtime config, without echoing it', async () => {
    const error = await loadSite({
      env: {},
      runtimeConfig: { githubSponsors: { token: PLACEHOLDER } },
    }).catch((cause: unknown) => cause)
    expect(String(error)).toMatch(/runtimeConfig\.githubSponsors\.token must be empty/)
    expect(String(error)).not.toContain(PLACEHOLDER)
  })

  it.each<{ label: string, hooks: Partial<NuxtHooks> }>([
    {
      label: 'nitro:config',
      hooks: {
        'nitro:config': (config) => {
          ;(config.runtimeConfig!.githubSponsors as Record<string, unknown>).token = PLACEHOLDER
        },
      },
    },
    {
      label: 'nitro:init',
      hooks: {
        'nitro:init': (nitro) => {
          ;(nitro.options.runtimeConfig.githubSponsors as Record<string, unknown>).token = PLACEHOLDER
        },
      },
    },
    {
      label: 'prerender:init',
      hooks: {
        'nitro:init': (nitro) => {
          nitro.options.prerender.routes.push('/')
          nitro.hooks.hook('prerender:init', (renderer) => {
            ;(renderer.options.runtimeConfig.githubSponsors as Record<string, unknown>).token = PLACEHOLDER
          })
        },
      },
    },
  ])('stops the build if $label puts a token in runtime config', async ({ hooks }) => {
    const nuxt = await loadSite({ env: {}, options: { mode: 'runtime' }, hooks })
    const error = await buildNuxt(nuxt).catch((cause: unknown) => cause)
    expect(String(error)).toMatch(/runtimeConfig\.githubSponsors\.token must be empty/)
    expect(String(error)).not.toContain(PLACEHOLDER)
  }, 30_000)

  it('checks runtime config after later Nitro build hooks run', async () => {
    const nuxt = await loadSite({ env: {}, options: { mode: 'runtime' } })
    const nitro = nuxt.runWithContext(() => useNitro())
    nitro.hooks.hook('rollup:before', (server) => {
      ;(server.options.runtimeConfig.githubSponsors as Record<string, unknown>).token = PLACEHOLDER
    })

    const error = await buildNuxt(nuxt).catch((cause: unknown) => cause)
    expect(String(error)).toMatch(/runtimeConfig\.githubSponsors\.token must be empty/)
    expect(String(error)).not.toContain(PLACEHOLDER)
  }, 30_000)

  it.each([
    { target: 'server', replace: false },
    { target: 'server', replace: true },
    { target: 'prerender', replace: false },
    { target: 'prerender', replace: true },
  ])('rejects an async $target plugin token before runtime config is emitted (replace: $replace)', async ({ target, replace }) => {
    let injected = false
    let emitted = false
    const nuxt = await loadSite({ env: {}, options: { mode: 'runtime' } })
    const nitro = nuxt.runWithContext(() => useNitro())
    const install = (instance: typeof nitro) => {
      instance.hooks.hook('rollup:before', (server, config) => {
        config.plugins = [config.plugins ?? [], {
          name: 'late-sponsors-token-fixture',
          async buildStart() {
            await new Promise(resolve => setTimeout(resolve, 10))
            if (replace) {
              server.options.runtimeConfig = {
                ...server.options.runtimeConfig,
                githubSponsors: { ...server.options.runtimeConfig.githubSponsors, token: PLACEHOLDER },
              }
            }
            else {
              ;(server.options.runtimeConfig.githubSponsors as Record<string, unknown>).token = PLACEHOLDER
            }
            injected = true
          },
          generateBundle() {
            emitted = true
          },
        }].flat()
      })
    }
    if (target === 'prerender') {
      nitro.options.prerender.routes.push('/')
      nitro.hooks.hook('prerender:init', install)
    }
    else {
      install(nitro)
    }

    const error = await buildNuxt(nuxt).catch((cause: unknown) => cause)
    expect(injected).toBe(true)
    expect(String(error)).toMatch(/runtimeConfig\.githubSponsors\.token must be empty/)
    expect(String(error)).not.toContain(PLACEHOLDER)
    expect(emitted).toBe(false)
  }, 30_000)

  it.each([
    { target: 'server', version: 2 },
    { target: 'prerender', version: 2 },
    { target: 'server', version: 3 },
    { target: 'prerender', version: 3 },
  ])('rejects a late $target sponsor serializer token before bundle generation (Nitro $version)', async ({ target, version }) => {
    let injected = false
    let serialized = false
    let emitted = false
    const nuxt = await loadSite({ env: {}, options: { mode: 'runtime' } })
    const nuxtNitro = nuxt.runWithContext(() => useNitro())
    const root = await mkdtemp(join(tmpdir(), 'sponsor-serializer-'))
    roots.push(root)
    await symlink(new URL('../node_modules', import.meta.url), join(root, 'node_modules'), 'dir')
    const entry = join(root, 'entry.ts')
    await writeFile(entry, 'import { useRuntimeConfig } from \'nitro/runtime-config\'\nexport default () => useRuntimeConfig()\n')
    const nitro3 = version === 3
      ? await createNitro({
          rootDir: root,
          entry,
          preset: target === 'prerender' ? 'nitro-prerender' : 'node-server',
          runtimeConfig: { githubSponsors: { token: '' } },
          logLevel: 0,
        })
      : undefined
    if (nitro3) {
      openNitros.push(nitro3)
      // Pass a real Nitro 3 builder through the module's renderer boundary.
      await nuxtNitro.hooks.callHook('prerender:init', nitro3 as unknown as typeof nuxtNitro)
    }
    const nitro = (nitro3 as unknown as typeof nuxtNitro | undefined) ?? nuxtNitro
    const install = (instance: typeof nitro) => {
      instance.hooks.hook('rollup:before', (server, config) => {
        config.plugins = [config.plugins ?? [], {
          name: 'late-sponsor-serializer-fixture',
          buildStart() {
            Object.assign(server.options.runtimeConfig, { githubSponsors: {
              ...server.options.runtimeConfig.githubSponsors,
              token: '',
              toJSON() {
                serialized = true
                return { token: PLACEHOLDER }
              },
            } })
            injected = true
          },
          generateBundle() {
            emitted = true
          },
        }].flat()
      })
    }
    if (target === 'prerender' && !nitro3) {
      nitro.options.prerender.routes.push('/')
      nitro.hooks.hook('prerender:init', install)
    }
    else {
      install(nitro)
    }

    const build = nitro3 ? buildNitro(nitro3) : buildNuxt(nuxt)
    const error = await build.catch((cause: unknown) => cause)
    expect(String(error)).toMatch(/runtimeConfig\.githubSponsors\.token must be empty/)
    expect(injected).toBe(true)
    expect(serialized).toBe(true)
    expect(String(error)).not.toContain(PLACEHOLDER)
    expect(emitted).toBe(false)
  }, 30_000)

  it('emits an empty token slot when a runtime build has an environment token', async () => {
    const nuxt = await loadSite({
      env: { NUXT_GITHUB_SPONSORS_TOKEN: PLACEHOLDER },
      options: { mode: 'runtime' },
    })
    const nitro = nuxt.runWithContext(() => useNitro())
    let serialized: string | undefined
    nitro.hooks.hook('rollup:before', (server, config) => {
      config.plugins = [config.plugins ?? [], {
        name: 'sponsors-runtime-config-fixture',
        generateBundle() {
          serialized = JSON.stringify(server.options.runtimeConfig)
        },
      }].flat()
    })

    await buildNuxt(nuxt)
    expect(JSON.parse(serialized!)).toMatchObject({ githubSponsors: { login: 'harlan-zw', token: '' } })
    expect(serialized).not.toContain(PLACEHOLDER)
  }, 30_000)
})
