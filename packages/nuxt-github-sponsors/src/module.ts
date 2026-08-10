import type { SponsorOverride, SponsorTier } from './runtime/shared/types'
import { addImports, addServerHandler, createResolver, defineNuxtModule } from '@nuxt/kit'

export interface ModuleOptions {
  login: string
  mode?: 'runtime' | 'prerender'
  route?: string
  tiers?: SponsorTier[]
  overrides?: Record<string, SponsorOverride>
}

const DEFAULT_TIERS: SponsorTier[] = [
  { key: 'partner', minimumMonthlyDollars: 50 },
  { key: 'supporter', minimumMonthlyDollars: 25 },
]

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@harlan-zw/nuxt-github-sponsors',
    configKey: 'githubSponsors',
  },
  defaults: {
    mode: 'runtime',
    route: '/api/github-sponsors',
    tiers: DEFAULT_TIERS,
    overrides: {},
  },
  setup(options, nuxt) {
    const login = options.login?.trim()
    if (!login)
      throw new TypeError('githubSponsors.login must be a non-empty GitHub login')
    const route = normalizeRoute(options.route)
    const tiers = parseSponsorTiers(options.tiers ?? DEFAULT_TIERS)
    const resolver = createResolver(import.meta.url)
    const privateConfig = nuxt.options.runtimeConfig as Record<string, unknown>
    const existingPrivate = privateConfig.githubSponsors as Record<string, unknown> | undefined
    privateConfig.githubSponsors = {
      token: '',
      login,
      tiers,
      overrides: options.overrides ?? {},
      ...existingPrivate,
    }
    const publicConfig = nuxt.options.runtimeConfig.public as Record<string, unknown>
    const existingPublic = publicConfig.githubSponsors as Record<string, unknown> | undefined
    publicConfig.githubSponsors = { route, ...existingPublic }

    addServerHandler({ route, handler: resolver.resolve('./runtime/server/api/sponsors.get') })
    addImports({ name: 'useGitHubSponsors', from: resolver.resolve('./runtime/app/composables/useGitHubSponsors') })
    if (options.mode === 'prerender') {
      const prerender = (nuxt.options.nitro.prerender ??= {})
      prerender.routes = [...(prerender.routes ?? []), route]
    }
  },
})

function normalizeRoute(value = '/api/github-sponsors'): string {
  const route = value.trim()
  if (!route.startsWith('/'))
    throw new TypeError('githubSponsors.route must start with /')
  return route.replace(/\/$/, '') || '/'
}

function parseSponsorTiers(input: SponsorTier[]): SponsorTier[] {
  const keys = new Set<string>()
  return input.map((tier) => {
    const key = tier.key.trim()
    if (!key || keys.has(key))
      throw new TypeError('githubSponsors.tiers must have unique, non-empty keys')
    if (!Number.isFinite(tier.minimumMonthlyDollars) || tier.minimumMonthlyDollars < 0)
      throw new TypeError(`githubSponsors tier ${key} must have a non-negative minimum`)
    keys.add(key)
    return { key, minimumMonthlyDollars: tier.minimumMonthlyDollars }
  }).toSorted((a, b) => b.minimumMonthlyDollars - a.minimumMonthlyDollars)
}
