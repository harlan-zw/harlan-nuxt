import type { GitHubSponsorsResponse, SponsorOverride, SponsorTier } from '../../shared/types'
import { defineEventHandler, useRuntimeConfig } from 'nuxt/server'
import { defineCachedFunction } from '#nuxt-github-sponsors/nitro'
import { fetchGitHubSponsorships, preparePublicSponsors, toGitHubSponsorsResponse } from '../github'

interface SponsorsRuntimeConfig {
  githubSponsors: {
    token?: string
    login: string
    tiers: SponsorTier[]
    overrides: Record<string, SponsorOverride>
  }
}

function readSponsorsConfig(): SponsorsRuntimeConfig['githubSponsors'] {
  return (useRuntimeConfig() as unknown as SponsorsRuntimeConfig).githubSponsors
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

export default defineEventHandler(async (): Promise<GitHubSponsorsResponse> => {
  const config = readSponsorsConfig()
  const fallback = preparePublicSponsors([], config.tiers, config.overrides).collection
  const token = config.token?.trim()
  if (!token)
    return toGitHubSponsorsResponse({ _tag: 'unavailable', reason: 'not-configured' }, fallback, new Date().toISOString())

  const { fetchedAt, result } = await cachedSponsorships({ login: config.login, token })
  if (result._tag === 'err') {
    console.error('[nuxt-github-sponsors] GitHub fetch failed', { errorTag: result.errorTag, message: result.errorMessage })
    return toGitHubSponsorsResponse({ _tag: 'unavailable', reason: 'upstream-error', errorTag: result.errorTag, errorMessage: result.errorMessage }, fallback, fetchedAt)
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
