import type { Nuxt } from '@nuxt/schema'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { loadNuxt } from 'nuxt'
import { afterEach, describe, expect, it } from 'vitest'
import sponsorsModule from '../src/module'

const PLACEHOLDER = 'inertSponsorsTokenPlaceholder9q4z'

const touchedEnv = new Set<string>()
const openNuxts: Nuxt[] = []

afterEach(async () => {
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
}): Promise<Nuxt> {
  for (const [name, value] of Object.entries(input.env)) {
    process.env[name] = value
    touchedEnv.add(name)
  }
  const nuxt = await loadNuxt({
    cwd: await mkdtemp(join(tmpdir(), 'nuxt-github-sponsors-')),
    ready: true,
    overrides: {
      dev: false,
      runtimeConfig: input.runtimeConfig,
      modules: [[sponsorsModule, { login: 'harlan-zw', ...input.options }]],
    },
  })
  openNuxts.push(nuxt)
  return nuxt
}

describe('build-time token boundary', () => {
  it.each([
    ['the default env name', 'NUXT_GITHUB_SPONSORS_TOKEN', {}],
    ['an aliased env name', 'NUXT_GITHUB_AUTH_TOKEN', { tokenEnv: 'NUXT_GITHUB_AUTH_TOKEN' }],
  ])('keeps a token in %s out of the runtime config Nitro serializes', async (_label, envName, options) => {
    const nuxt = await loadSite({ env: { [envName]: PLACEHOLDER }, options })
    expect(JSON.stringify(nuxt.options.runtimeConfig)).not.toContain(PLACEHOLDER)
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
})
