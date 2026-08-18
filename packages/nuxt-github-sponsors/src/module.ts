import type { SponsorsMode } from './options'
import type { SponsorOverride, SponsorTier } from './runtime/shared/types'
import process from 'node:process'
import { addImports, addServerHandler, addTypeTemplate, createResolver, defineNuxtModule, useLogger } from '@nuxt/kit'
import {
  DEFAULT_TIERS,
  DEFAULT_TOKEN_ENV,
  normalizeRoute,
  parseSponsorTiers,
  planSponsorDelivery,
  renderSponsorTierAugmentation,
  resolveSponsorToken,
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
    compatibility: { nuxt: '>=4.5.0 <5.0.0' },
  },
  defaults: {
    mode: 'prerender',
    route: '/api/github-sponsors',
    tiers: DEFAULT_TIERS,
    overrides: {},
    tokenEnv: DEFAULT_TOKEN_ENV,
  },
  setup(options, nuxt) {
    const logger = useLogger('@harlan-zw/nuxt-github-sponsors')
    const login = options.login?.trim()
    if (!login)
      throw new TypeError('githubSponsors.login must be a non-empty GitHub login')
    const route = normalizeRoute(options.route)
    const tiers = parseSponsorTiers(options.tiers ?? DEFAULT_TIERS)
    const tokenEnv = options.tokenEnv?.trim() || DEFAULT_TOKEN_ENV
    const mode = options.mode ?? 'prerender'
    const resolver = createResolver(import.meta.url)

    const token = resolveSponsorToken(process.env, tokenEnv)
    const privateConfig = nuxt.options.runtimeConfig as Record<string, unknown>
    const existingPrivate = privateConfig.githubSponsors as Record<string, unknown> | undefined
    privateConfig.githubSponsors = {
      token: token._tag === 'ok' ? token.token : '',
      login,
      tiers,
      overrides: options.overrides ?? {},
      ...existingPrivate,
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
