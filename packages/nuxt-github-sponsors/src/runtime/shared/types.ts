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

/**
 * The module augments this interface with the configured tier keys, so a page
 * that reads a renamed tier fails to compile instead of rendering nothing.
 */
export interface ConfiguredSponsorTiers {}

export type SponsorTierKey = keyof ConfiguredSponsorTiers extends never
  ? string
  : Extract<keyof ConfiguredSponsorTiers, string>

export interface SponsorOverride {
  name?: string
  websiteUrl?: string | null
}

export type GitHubSponsorsErrorTag
  = | 'NetworkError'
    | 'HttpError'
    | 'InvalidResponse'
    | 'GraphQLError'
    | 'UserNotFound'
    | 'PaginationError'

export interface SponsorCollection {
  sponsors: PublicGitHubSponsor[]
  tiers: Record<SponsorTierKey, PublicGitHubSponsor[]>
  ungrouped: PublicGitHubSponsor[]
}

export type GitHubSponsorsResponse
  = | ({ _tag: 'available', fetchedAt: string } & SponsorCollection)
    | ({ _tag: 'unavailable', reason: 'not-configured' } & SponsorCollection)
    | ({ _tag: 'unavailable', reason: 'upstream-error', errorTag: GitHubSponsorsErrorTag } & SponsorCollection)
