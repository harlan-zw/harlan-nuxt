import type { SponsorsMode } from './options'
import type { SponsorOverride, SponsorTier } from './runtime/shared/types'
import process from 'node:process'
import { addImports, addServerHandler, addTypeTemplate, createResolver, defineNuxtModule, resolveServerVariant, useLogger } from '@nuxt/kit'
import {
  DEFAULT_TOKEN_ENV,
  detectSponsorToken,
  normalizeRoute,
  planSponsorDelivery,
  renderSponsorTierAugmentation,
  resolveSponsorTiers,
} from './options'

export interface ModuleOptions {
  login: string
  /**
   * `prerender` bakes the route at build. `runtime` serves it with a one-day SWR
   * cache. `client` skips server rendering, so the page fetches after mount.
   */
  mode?: SponsorsMode
  route?: string
  tiers?: SponsorTier[]
  overrides?: Record<string, SponsorOverride>
  /** Env name holding the GitHub token. Alias it when the default name is taken. */
  tokenEnv?: string
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@harlan-zw/nuxt-github-sponsors',
    configKey: 'githubSponsors',
    compatibility: { nuxt: '^4.6.0 || ^5.0.0' },
  },
  /**
   * `tiers` is absent on purpose. Nuxt merges these defaults with `defu`, which
   * concatenates arrays, so a declared default would append the shipped tiers to the
   * authored ones. A site that names its own `top` tier then fails on a duplicate key.
   * `setup` falls back to `DEFAULT_TIERS` instead, where a list replaces rather than joins.
   */
  defaults: {
    mode: 'prerender',
    route: '/api/github-sponsors',
    overrides: {},
    tokenEnv: DEFAULT_TOKEN_ENV,
  },
  setup(options, nuxt) {
    const logger = useLogger('@harlan-zw/nuxt-github-sponsors')
    const login = options.login?.trim()
    if (!login)
      throw new TypeError('githubSponsors.login must be a non-empty GitHub login')
    const route = normalizeRoute(options.route)
    const tiers = resolveSponsorTiers(options.tiers)
    const tokenEnv = options.tokenEnv?.trim() || DEFAULT_TOKEN_ENV
    const mode = options.mode ?? 'prerender'
    const resolver = createResolver(import.meta.url)
    const serverRuntime = resolveServerVariant({ nitro2: resolver.resolve('./runtime/server/nitro2'), nitro3: resolver.resolve('./runtime/server/nitro3') })!
    nuxt.options.alias['#nuxt-github-sponsors/nitro'] = serverRuntime
    ;(nuxt.options.nitro.alias ??= {})['#nuxt-github-sponsors/nitro'] = serverRuntime

    const token = detectSponsorToken(process.env, tokenEnv)
    const privateConfig = nuxt.options.runtimeConfig as Record<string, unknown>
    const existingPrivate = privateConfig.githubSponsors as Record<string, unknown> | undefined
    const assertEmptyToken = (runtimeConfig: Record<string, unknown>) => {
      const sponsors = runtimeConfig.githubSponsors as Record<string, unknown> | undefined
      if (sponsors?.token) {
        throw new TypeError([
          'runtimeConfig.githubSponsors.token must be empty.',
          'Nitro writes runtime config into the server bundle, so a value there ships with the deploy.',
          `Set the token in the ${tokenEnv} environment variable instead.`,
        ].join(' '))
      }
    }
    assertEmptyToken(privateConfig)
    const guardSerialization = (options: { runtimeConfig: Record<string, unknown> }) => {
      const protect = (config: Record<string, unknown>) => {
        // Nitro 2 and 3 call JSON.stringify when emitting runtime config.
        // Check then, since later hooks can still populate or replace the slot.
        Object.defineProperty(config, 'toJSON', {
          configurable: true,
          value: () => {
            assertEmptyToken(config)
            return config
          },
        })
        return config
      }
      let config = protect(options.runtimeConfig)
      Object.defineProperty(options, 'runtimeConfig', {
        configurable: true,
        enumerable: true,
        get: () => config,
        set: (value: Record<string, unknown>) => { config = protect(value) },
      })
    }
    nuxt.hook('nitro:init', (nitro) => {
      assertEmptyToken(nitro.options.runtimeConfig)
      guardSerialization(nitro.options)
      // Nitro creates a separate instance for prerendering.
      nitro.hooks.hook('prerender:init', renderer => guardSerialization(renderer.options))
    })
    privateConfig.githubSponsors = {
      login,
      tiers,
      overrides: options.overrides ?? {},
      // The env name, never its value. The route reads the value per request.
      tokenEnv,
      ...existingPrivate,
      // Always empty in the bundle. It stays declared because Nitro applies an env
      // override, here NUXT_GITHUB_SPONSORS_TOKEN, only to a key that exists.
      token: '',
    }
    const publicConfig = nuxt.options.runtimeConfig.public as Record<string, unknown>
    const existingPublic = publicConfig.githubSponsors as Record<string, unknown> | undefined
    publicConfig.githubSponsors = { route, mode, ...existingPublic }

    addServerHandler({ route, handler: resolver.resolve('./runtime/server/api/sponsors.get') })
    addImports({ name: 'useGitHubSponsors', from: resolver.resolve('./runtime/app/composables/useGitHubSponsors') })
    addTypeTemplate({
      filename: 'types/github-sponsors.d.ts',
      getContents: () => renderSponsorTierAugmentation(tiers),
    }, { nuxt: true, nitro: true })

    const plan = planSponsorDelivery(mode, token)
    if (plan._tag === 'prerender-skipped')
      logger.warn(plan.warning)
    if (plan._tag !== 'prerender')
      return

    // A route rule, never nitro.prerender.routes, so a site can turn the
    // prerender off with its own route rule for the same path.
    const nitro = (nuxt.options.nitro ??= {})
    const routeRules = (nitro.routeRules ??= {})
    routeRules[route] = { prerender: true, ...routeRules[route] }
  },
})
