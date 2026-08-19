import type { GitHubSponsorsResponse } from '../../shared/types'
import { useFetch, useRuntimeConfig } from '#app'

export function useGitHubSponsors() {
  const config = useRuntimeConfig()
  const githubSponsors = (config.public as Record<string, unknown>).githubSponsors as { route: string, mode: 'runtime' | 'prerender' | 'client' }
  return useFetch<GitHubSponsorsResponse>(githubSponsors.route, {
    key: `github-sponsors:${githubSponsors.route}`,
    // Client mode keeps sponsors out of the rendered HTML, so the page needs no
    // onMounted gate of its own.
    server: githubSponsors.mode !== 'client',
  })
}
