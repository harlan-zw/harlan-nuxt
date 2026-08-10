export interface PublicGitHubSponsor {
  avatarUrl: string
  login: string
  monthlyDollars: number
  name: string
  profileUrl: string
  websiteUrl: string | null
}

export interface SponsorTier {
  key: string
  minimumMonthlyDollars: number
}

export interface SponsorOverride {
  name?: string
  websiteUrl?: string | null
}

export interface SponsorCollection {
  sponsors: PublicGitHubSponsor[]
  tiers: Record<string, PublicGitHubSponsor[]>
  ungrouped: PublicGitHubSponsor[]
}

export type GitHubSponsorsResponse
  = | ({ _tag: 'available', fetchedAt: string } & SponsorCollection)
    | ({ _tag: 'unavailable', reason: 'not-configured' } & SponsorCollection)
