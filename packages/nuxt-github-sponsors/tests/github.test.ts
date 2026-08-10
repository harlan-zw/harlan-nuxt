import { describe, expect, it, vi } from 'vitest'
import { fetchGitHubSponsorFeed } from '../src/runtime/server/github'

function sponsorNode(login: string, amount = 25, privacyLevel = 'PUBLIC', websiteUrl: string | null = 'example.com', isOneTime = false) {
  return {
    createdAt: '2026-01-01T00:00:00Z',
    isActive: true,
    privacyLevel,
    raw: 'must-not-leak',
    sponsorEntity: {
      __typename: 'User',
      avatarUrl: `https://avatars.example.com/${login}`,
      login,
      name: null,
      websiteUrl,
    },
    tier: { isOneTime, monthlyPriceInDollars: amount, name: 'Supporter' },
  }
}

function githubResponse(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return new Response(JSON.stringify({
    data: { user: { sponsorshipsAsMaintainer: { nodes, pageInfo: { endCursor, hasNextPage } } } },
  }), { headers: { 'content-type': 'application/json' } })
}

describe('github sponsors', () => {
  it('fetches typed sponsors and follows pagination', async () => {
    const responses = [
      githubResponse([sponsorNode('first')], true, 'next-page'),
      githubResponse([sponsorNode('second', 25, 'PUBLIC', null)]),
    ]
    const fetchMock = vi.fn(async () => responses.shift()!) as unknown as typeof fetch
    const result = await fetchGitHubSponsorFeed({
      token: 'secret',
      login: 'harlan-zw',
      fetch: fetchMock,
      tiers: [{ key: 'supporter', minimumMonthlyDollars: 25 }],
    })
    expect(result._tag).toBe('available')
    if (result._tag === 'available') {
      expect(result.collection.sponsors).toHaveLength(2)
      expect(result.collection.sponsors[0]).toMatchObject({ name: 'first', websiteUrl: 'https://example.com' })
    }
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns tagged HTTP failures', async () => {
    const fetchMock = vi.fn(async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch
    await expect(fetchGitHubSponsorFeed({ token: 'secret', login: 'harlan-zw', fetch: fetchMock, tiers: [] }))
      .resolves
      .toEqual({ _tag: 'unavailable', reason: 'upstream-error', errorTag: 'HttpError' })
  })

  it('filters private sponsors, projects a minimal DTO, and assigns exact tier thresholds', async () => {
    const fetchMock = vi.fn(async () => githubResponse([
      sponsorNode('private', 100, 'PRIVATE'),
      sponsorNode('one-time', 100, 'PUBLIC', null, true),
      sponsorNode('partner', 50),
      sponsorNode('supporter', 25),
      sponsorNode('backer', 5),
    ])) as unknown as typeof fetch
    const result = await fetchGitHubSponsorFeed({
      token: 'secret',
      login: 'harlan-zw',
      fetch: fetchMock,
      tiers: [
        { key: 'partner', minimumMonthlyDollars: 50 },
        { key: 'supporter', minimumMonthlyDollars: 25 },
      ],
      overrides: { partner: { name: 'Partner Inc.' } },
    })
    expect(result._tag).toBe('available')
    if (result._tag !== 'available')
      return
    expect(result.collection.sponsors.map(sponsor => sponsor.name)).toEqual(['Partner Inc.', 'supporter', 'backer'])
    expect(result.collection.tiers.partner?.map(sponsor => sponsor.login)).toEqual(['partner'])
    expect(result.collection.tiers.supporter?.map(sponsor => sponsor.login)).toEqual(['supporter'])
    expect(result.collection.ungrouped.map(sponsor => sponsor.login)).toEqual(['backer'])
    expect(result.collection.sponsors[0]).toEqual({
      avatarUrl: 'https://avatars.example.com/partner',
      login: 'partner',
      monthlyDollars: 50,
      name: 'Partner Inc.',
      profileUrl: 'https://github.com/partner',
      websiteUrl: 'https://example.com',
    })
  })

  it('does not call GitHub without a token', async () => {
    const fetchMock = vi.fn()
    await expect(fetchGitHubSponsorFeed({ login: 'harlan-zw', fetch: fetchMock, tiers: [] }))
      .resolves
      .toEqual({ _tag: 'unavailable', reason: 'not-configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('removes unsafe website URLs', async () => {
    const unsafe = sponsorNode('unsafe')
    unsafe.sponsorEntity.websiteUrl = 'javascript:alert(1)'
    const fetchMock = vi.fn(async () => githubResponse([unsafe])) as unknown as typeof fetch
    const result = await fetchGitHubSponsorFeed({ token: 'secret', login: 'harlan-zw', fetch: fetchMock, tiers: [] })
    expect(result._tag === 'available' ? result.collection.sponsors[0]?.websiteUrl : 'unavailable').toBeNull()
  })
})
