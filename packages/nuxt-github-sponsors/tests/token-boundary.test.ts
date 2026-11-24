import type { Nuxt } from '@nuxt/schema'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { useNitro } from '@nuxt/kit'
import { getRollupConfig } from 'nitropack/rollup'
import { loadNuxt } from 'nuxt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import sponsorsModule from '../src/module'

const PLACEHOLDER = 'inertSponsorsTokenPlaceholder9q4z'

const touchedEnv = new Set<string>()
const openNuxts: Nuxt[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const name of touchedEnv)
    delete process.env[name]
  touchedEnv.clear()
  await Promise.all(openNuxts.splice(0).map(nuxt => nuxt.close()))
})

/** Runs the module the way a site build does, with the token in the build env. */
async function loadSite(input: {
  env: Record<string, string>
  options?: Record<string, unknown>
  runtimeConfig?: Record<string, unknown>
  lateNitroToken?: boolean
  lateInitToken?: 'slot' | 'sponsors' | 'config'
}): Promise<Nuxt> {
  for (const [name, value] of Object.entries(input.env)) {
    process.env[name] = value
    touchedEnv.add(name)
  }
  const nuxt = await loadNuxt({
    cwd: await mkdtemp(join(tmpdir(), 'nuxt-github-sponsors-')),
    ready: false,
    overrides: {
      dev: false,
      runtimeConfig: input.runtimeConfig,
      modules: [
        (_options, nuxt) => sponsorsModule({ login: 'harlan-zw', ...input.options }, nuxt),
        (_options, nuxt) => {
          if (input.lateInitToken) {
            nuxt.hook('nitro:init', (nitro) => {
              const sponsors = { ...nitro.options.runtimeConfig.githubSponsors, token: PLACEHOLDER }
              if (input.lateInitToken === 'config')
                nitro.options.runtimeConfig = { ...nitro.options.runtimeConfig, githubSponsors: sponsors }
              else if (input.lateInitToken === 'sponsors')
                nitro.options.runtimeConfig.githubSponsors = sponsors
              else
                (nitro.options.runtimeConfig.githubSponsors as { token: string }).token = PLACEHOLDER
            })
          }
          if (input.lateNitroToken) {
            nuxt.hook('nitro:config', (config) => {
              config.runtimeConfig ??= {}
              config.runtimeConfig.githubSponsors = { token: PLACEHOLDER }
            })
          }
        },
      ],
    },
  })
  openNuxts.push(nuxt)
  await nuxt.ready()
  return nuxt
}

describe('build-time token boundary', () => {
  it.each(['slot', 'sponsors', 'config'] as const)('rejects a later nitro:init token at bundle serialization after replacing %s', async (lateInitToken) => {
    const output: string[] = []
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, 'write').mockImplementation((chunk) => {
        output.push(String(chunk))
        return true
      })
    }
    const error = await loadSite({ env: {}, options: { mode: 'runtime' }, lateInitToken })
      // Exercise Nitro's real config replacement without a full site build.
      .then(nuxt => nuxt.runWithContext(async () => {
        const config = getRollupConfig(useNitro())
        for (const plugin of config.plugins ?? []) {
          if (!plugin || !('name' in plugin) || plugin.name !== 'replace' || !('transform' in plugin) || !plugin.transform)
            continue
          const transform = typeof plugin.transform === 'function' ? plugin.transform : plugin.transform.handler
          await Reflect.apply(transform, {}, ['export default process.env.RUNTIME_CONFIG', 'runtime-config.js'])
        }
        return undefined
      }))
      .catch((cause: unknown) => String(cause))
    expect(error).toMatch(/runtimeConfig\.githubSponsors\.token must be empty/)
    expect(error?.includes(PLACEHOLDER)).toBe(false)
    expect(output.join('').includes(PLACEHOLDER)).toBe(false)
  })

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

  it.each(['prerender', 'runtime', 'client'])('rejects a later nitro:config token in %s mode without echoing it', async (mode) => {
    const output: string[] = []
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, 'write').mockImplementation((chunk) => {
        output.push(String(chunk))
        return true
      })
    }
    const error = await loadSite({
      env: {},
      options: { mode },
      lateNitroToken: true,
    }).then(() => undefined, (cause: unknown) => String(cause))
    expect(error).toMatch(/runtimeConfig\.githubSponsors\.token must be empty/)
    expect(error).not.toContain(PLACEHOLDER)
    expect(output.join('')).not.toContain(PLACEHOLDER)
  })
})
