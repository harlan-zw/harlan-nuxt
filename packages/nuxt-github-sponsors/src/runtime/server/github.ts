import type { GitHubSponsorsErrorTag, GitHubSponsorsResponse, PublicGitHubSponsor, SponsorCollection, SponsorOverride, SponsorTier, SponsorTierKey } from '../shared/types'
import { z } from 'zod'

const GitHubSponsorsResponseSchema = z.object({
  data: z.object({
    user: z.object({
      sponsorshipsAsMaintainer: z.object({
        nodes: z.array(z.object({
          createdAt: z.string(),
          isActive: z.boolean(),
          privacyLevel: z.string(),
          sponsorEntity: z.object({
            __typename: z.string(),
            avatarUrl: z.string(),
            login: z.string(),
            name: z.string().nullable(),
            websiteUrl: z.string().nullable(),
          }).nullable(),
          tier: z.object({
            isOneTime: z.boolean(),
            monthlyPriceInDollars: z.number(),
            name: z.string(),
          }).nullable(),
        })),
        pageInfo: z.object({
          endCursor: z.string().nullable(),
          hasNextPage: z.boolean(),
        }),
      }),
    }).nullable(),
  }).optional(),
  errors: z.array(z.object({ message: z.string() }).passthrough()).optional(),
})

const SPONSORS_QUERY = `
  query Sponsors($login: String!, $cursor: String) {
    user(login: $login) {
      sponsorshipsAsMaintainer(activeOnly: true, first: 100, after: $cursor) {
        nodes {
          createdAt
          isActive
          privacyLevel
          sponsorEntity {
            ... on User { __typename avatarUrl login name websiteUrl }
            ... on Organization { __typename avatarUrl login name websiteUrl }
          }
          tier { isOneTime monthlyPriceInDollars name }
        }
        pageInfo { endCursor hasNextPage }
      }
    }
  }
`

export interface SourceSponsorship {
  monthlyDollars: number
  privacyLevel: string
  sponsor: {
    avatarUrl: string
    linkUrl: string
    login: string
    name: string
    websiteUrl: string | null
  }
}

export interface GitHubSponsorsFetchError extends Error {
  _tag: GitHubSponsorsErrorTag
  status?: number
}

type GitHubSponsorsFetchResult
  = | { _tag: 'ok', value: SourceSponsorship[] }
    | { _tag: 'err', error: GitHubSponsorsFetchError }

export interface PreparedSponsors {
  collection: SponsorCollection
  /** Override keys that matched no sponsor. Each one is a silent no-op. */
  unmatchedOverrides: string[]
}

export type SponsorFeedResult
  = | { _tag: 'available', collection: SponsorCollection, unmatchedOverrides: string[] }
    | { _tag: 'unavailable', reason: 'not-configured' }
    | { _tag: 'unavailable', reason: 'upstream-error', errorTag: GitHubSponsorsErrorTag, errorMessage: string }

export type SponsorshipsResult
  = { _tag: 'ok', sponsorships: SourceSponsorship[] }
    /**
     * `errorMessage` is what GitHub said. It stays server side, for the log only.
     * Without it a rejected token, a missing scope and a rate limit all read as
     * `GraphQLError`, which is the same as saying nothing.
     */
    | { _tag: 'err', errorTag: GitHubSponsorsErrorTag, errorMessage: string }

/**
 * The upstream call on its own. Tier grouping and overrides stay out, so a
 * cached result survives a tier rename.
 */
export async function fetchGitHubSponsorships(input: {
  token: string
  login: string
  fetch?: typeof fetch
  timeoutMs?: number
  userAgent?: string
}): Promise<SponsorshipsResult> {
  const result = await fetchActiveGitHubSponsors(input)
  return result._tag === 'ok'
    ? { _tag: 'ok', sponsorships: result.value }
    : { _tag: 'err', errorTag: result.error._tag, errorMessage: result.error.message }
}

export async function fetchGitHubSponsorFeed(input: {
  token?: string
  login: string
  tiers: SponsorTier[]
  overrides?: Record<string, SponsorOverride>
  fetch?: typeof fetch
  timeoutMs?: number
  userAgent?: string
}): Promise<SponsorFeedResult> {
  const token = input.token?.trim()
  if (!token)
    return { _tag: 'unavailable', reason: 'not-configured' }
  const result = await fetchGitHubSponsorships({ ...input, token })
  if (result._tag === 'err')
    return { _tag: 'unavailable', reason: 'upstream-error', errorTag: result.errorTag, errorMessage: result.errorMessage }
  const prepared = preparePublicSponsors(result.sponsorships, input.tiers, input.overrides)
  return { _tag: 'available', collection: prepared.collection, unmatchedOverrides: prepared.unmatchedOverrides }
}

/**
 * An upstream failure is a state, never a thrown 502. A prerender with
 * failOnError then keeps building, and every consumer branches once.
 */
export function toGitHubSponsorsResponse(
  result: SponsorFeedResult,
  fallback: SponsorCollection,
  fetchedAt: string,
): GitHubSponsorsResponse {
  if (result._tag === 'available')
    return { _tag: 'available', fetchedAt, ...result.collection }
  if (result.reason === 'upstream-error')
    // `errorMessage` deliberately stops here. The browser gets the tag, the server log
    // gets what GitHub said, so upstream detail never reaches a page.
    return { _tag: 'unavailable', reason: 'upstream-error', errorTag: result.errorTag, ...fallback }
  return { _tag: 'unavailable', reason: 'not-configured', ...fallback }
}

async function fetchActiveGitHubSponsors(input: {
  token: string
  login: string
  fetch?: typeof fetch
  timeoutMs?: number
  userAgent?: string
}): Promise<GitHubSponsorsFetchResult> {
  const fetchImpl = input.fetch ?? globalThis.fetch
  const sponsors: SourceSponsorship[] = []
  let cursor: string | null = null

  for (let page = 0; page < 10; page++) {
    const response = await fetchImpl('https://api.github.com/graphql', {
      body: JSON.stringify({ query: SPONSORS_QUERY, variables: { cursor, login: input.login } }),
      headers: {
        'accept': 'application/vnd.github+json',
        'authorization': `Bearer ${input.token}`,
        'content-type': 'application/json',
        'user-agent': input.userAgent ?? '@harlan-zw/nuxt-github-sponsors',
      },
      method: 'POST',
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
    }).then(
      response => ({ _tag: 'ok' as const, response }),
      cause => ({ _tag: 'err' as const, error: sponsorsError('NetworkError', 'GitHub Sponsors request failed', { cause }) }),
    )
    if (response._tag === 'err')
      return response
    if (!response.response.ok) {
      return { _tag: 'err', error: sponsorsError('HttpError', `GitHub Sponsors request failed with status ${response.response.status}`, { status: response.response.status }) }
    }

    const json = await response.response.json().then(
      value => ({ _tag: 'ok' as const, value }),
      cause => ({ _tag: 'err' as const, error: sponsorsError('InvalidResponse', 'GitHub Sponsors returned invalid JSON', { cause }) }),
    )
    if (json._tag === 'err')
      return json
    const result = GitHubSponsorsResponseSchema.safeParse(json.value)
    if (!result.success)
      return { _tag: 'err', error: sponsorsError('InvalidResponse', 'GitHub Sponsors response did not match the expected schema', { cause: result.error }) }
    if (result.data.errors?.length)
      return { _tag: 'err', error: sponsorsError('GraphQLError', result.data.errors[0]?.message || 'GitHub Sponsors returned an unknown GraphQL error') }

    const connection = result.data.data?.user?.sponsorshipsAsMaintainer
    if (!connection)
      return { _tag: 'err', error: sponsorsError('UserNotFound', `GitHub Sponsors user ${input.login} was not found`) }

    for (const node of connection.nodes) {
      if (!node.isActive || !node.sponsorEntity || !node.tier || node.tier.isOneTime)
        continue
      const sponsor = node.sponsorEntity
      sponsors.push({
        monthlyDollars: node.tier.monthlyPriceInDollars,
        privacyLevel: node.privacyLevel,
        sponsor: {
          avatarUrl: sponsor.avatarUrl,
          linkUrl: `https://github.com/${sponsor.login}`,
          login: sponsor.login,
          name: sponsor.name || sponsor.login,
          websiteUrl: sponsor.websiteUrl,
        },
      })
    }

    if (!connection.pageInfo.hasNextPage)
      return { _tag: 'ok', value: sponsors }
    if (!connection.pageInfo.endCursor)
      return { _tag: 'err', error: sponsorsError('PaginationError', 'GitHub Sponsors pagination cursor was missing') }
    cursor = connection.pageInfo.endCursor
  }

  return { _tag: 'err', error: sponsorsError('PaginationError', 'GitHub Sponsors pagination exceeded 10 pages') }
}

export function preparePublicSponsors(
  sponsorships: readonly SourceSponsorship[],
  tiers: readonly SponsorTier[],
  overrides: Readonly<Record<string, SponsorOverride>> = {},
): PreparedSponsors {
  const sortedTiers = [...tiers].toSorted((a, b) => b.minimumMonthlyDollars - a.minimumMonthlyDollars)
  const groups = Object.fromEntries(sortedTiers.map(tier => [tier.key, [] as PublicGitHubSponsor[]])) as SponsorCollection['tiers']
  const matchedOverrides = new Set<string>()
  const sponsors = sponsorships
    .filter(sponsorship => sponsorship.privacyLevel === 'PUBLIC')
    .map((sponsorship) => {
      const overrideKey = sponsorship.sponsor.login in overrides
        ? sponsorship.sponsor.login
        : sponsorship.sponsor.name in overrides ? sponsorship.sponsor.name : undefined
      if (overrideKey !== undefined)
        matchedOverrides.add(overrideKey)
      const override = overrideKey === undefined ? undefined : overrides[overrideKey]
      const websiteUrl = override && 'websiteUrl' in override
        ? normalizeWebsiteUrl(override.websiteUrl ?? null)
        : normalizeWebsiteUrl(sponsorship.sponsor.websiteUrl)
      return {
        avatarUrl: safeHttpUrl(sponsorship.sponsor.avatarUrl) ?? '',
        login: sponsorship.sponsor.login,
        monthlyDollars: sponsorship.monthlyDollars,
        name: override?.name ?? sponsorship.sponsor.name,
        profileUrl: safeHttpUrl(sponsorship.sponsor.linkUrl) ?? `https://github.com/${encodeURIComponent(sponsorship.sponsor.login)}`,
        websiteUrl,
      } satisfies PublicGitHubSponsor
    })
  const ungrouped: PublicGitHubSponsor[] = []
  for (const sponsorship of sponsors) {
    const tier = sortedTiers.find(candidate => sponsorship.monthlyDollars >= candidate.minimumMonthlyDollars)
    if (tier)
      groups[tier.key as SponsorTierKey]!.push(sponsorship)
    else
      ungrouped.push(sponsorship)
  }
  return {
    collection: { sponsors, tiers: groups, ungrouped },
    unmatchedOverrides: Object.keys(overrides).filter(key => !matchedOverrides.has(key)),
  }
}

function normalizeWebsiteUrl(value: string | null): string | null {
  if (!value)
    return null
  try {
    return safeHttpUrl(/^https?:\/\//i.test(value) ? value : `https://${value}`)?.replace(/\/$/, '') ?? null
  }
  catch {
    return null
  }
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  }
  catch {
    // Provider-controlled URLs are optional display data. Reject malformed values.
    return null
  }
}

function sponsorsError(
  tag: GitHubSponsorsFetchError['_tag'],
  message: string,
  details: { cause?: unknown, status?: number } = {},
): GitHubSponsorsFetchError {
  return Object.assign(new Error(message, details.cause === undefined ? undefined : { cause: details.cause }), {
    _tag: tag,
    ...(details.status === undefined ? {} : { status: details.status }),
  })
}
