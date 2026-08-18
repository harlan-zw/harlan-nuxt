import type { GitHubSponsorsResponse, SponsorOverride, SponsorTier } from '../../shared/types'
import { defineCachedFunction } from 'nitropack/runtime'
import { fetchGitHubSponsorships, preparePublicSponsors, toGitHubSponsorsResponse } from '../github'

interface SponsorsRuntimeConfig {
  githubSponsors: {
    token?: string
    login: string
    tiers: SponsorTier[]
    overrides: Record<string, SponsorOverride>
  }
}

// nitropack ships h3 v1 types while the app runs h3 v2. One event object, two
// type packages, so the event crosses the boundary as an opaque value.
function readSponsorsConfig(event: unknown): SponsorsRuntimeConfig['githubSponsors'] {
  const config = useRuntimeConfig(event as Parameters<typeof useRuntimeConfig>[0]) as unknown as SponsorsRuntimeConfig
  return config.githubSponsors
}

const cachedSponsorships = defineCachedFunction(async (input: { login: string, token: string }) => ({
  fetchedAt: new Date().toISOString(),
  result: await fetchGitHubSponsorships(input),
}), {
  maxAge: 60 * 60 * 24,
  name: 'github-sponsors',
  group: 'nitro/functions',
  swr: true,
  getKey: input => input.login,
  // Only a successful upstream result earns a day of cache.
  validate: entry => entry.value?.result._tag === 'ok',
})

export default defineEventHandler(async (event): Promise<GitHubSponsorsResponse> => {
  const config = readSponsorsConfig(event)
  const fallback = preparePublicSponsors([], config.tiers, config.overrides).collection
  const token = config.token?.trim()
  if (!token)
    return toGitHubSponsorsResponse({ _tag: 'unavailable', reason: 'not-configured' }, fallback, new Date().toISOString())

  const { fetchedAt, result } = await cachedSponsorships({ login: config.login, token })
  if (result._tag === 'err') {
    console.error('[nuxt-github-sponsors] GitHub fetch failed', { errorTag: result.errorTag })
    return toGitHubSponsorsResponse({ _tag: 'unavailable', reason: 'upstream-error', errorTag: result.errorTag }, fallback, fetchedAt)
  }

  const prepared = preparePublicSponsors(result.sponsorships, config.tiers, config.overrides)
  if (prepared.unmatchedOverrides.length > 0)
    console.warn('[nuxt-github-sponsors] These override keys matched no sponsor:', prepared.unmatchedOverrides.join(', '))
  return toGitHubSponsorsResponse(
    { _tag: 'available', collection: prepared.collection, unmatchedOverrides: prepared.unmatchedOverrides },
    fallback,
    fetchedAt,
  )
})
