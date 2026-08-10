import type { GitHubSponsorsResponse, SponsorOverride, SponsorTier } from '../../shared/types'
import { defineCachedEventHandler, useRuntimeConfig } from 'nitropack/runtime'
import { fetchGitHubSponsorFeed, preparePublicSponsors } from '../github'

interface SponsorsRuntimeConfig {
  githubSponsors: {
    token?: string
    login: string
    tiers: SponsorTier[]
    overrides: Record<string, SponsorOverride>
  }
}

function readSponsorsConfig(event: Parameters<typeof useRuntimeConfig>[0]): SponsorsRuntimeConfig['githubSponsors'] {
  const config = useRuntimeConfig(event) as unknown as SponsorsRuntimeConfig
  return config.githubSponsors
}

export default defineCachedEventHandler(async (event): Promise<GitHubSponsorsResponse> => {
  const config = readSponsorsConfig(event)
  const collection = preparePublicSponsors([], config.tiers, config.overrides)
  const token = config.token?.trim()
  if (!token)
    return { _tag: 'unavailable', reason: 'not-configured', ...collection }

  const result = await fetchGitHubSponsorFeed({ ...config, token })
  if (result._tag === 'unavailable') {
    console.error('[nuxt-github-sponsors] GitHub fetch failed', { errorTag: result.errorTag })
    throw Object.assign(new Error('Failed to refresh sponsor data'), {
      statusCode: 502,
      statusMessage: 'Failed to refresh sponsor data',
    })
  }

  return { _tag: 'available', fetchedAt: new Date().toISOString(), ...result.collection }
}, {
  maxAge: 60 * 60 * 24,
  name: 'github-sponsors',
  shouldBypassCache: event => !readSponsorsConfig(event).token?.trim(),
  swr: true,
})
