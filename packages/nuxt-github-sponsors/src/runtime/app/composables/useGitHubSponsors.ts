import type { GitHubSponsorsResponse } from '../../shared/types'
import { useFetch, useRuntimeConfig } from '#app'

export function useGitHubSponsors() {
  const config = useRuntimeConfig()
  const githubSponsors = (config.public as Record<string, unknown>).githubSponsors as { route: string }
  return useFetch<GitHubSponsorsResponse>(githubSponsors.route, {
    key: `github-sponsors:${githubSponsors.route}`,
  })
}
