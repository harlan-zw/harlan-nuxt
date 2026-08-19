import { describe, expect, it } from 'vitest'
import { preparePublicSponsors, toGitHubSponsorsResponse } from '../src/runtime/server/github'

const tiers = [{ key: 'top', minimumMonthlyDollars: 50 }]
const empty = preparePublicSponsors([], tiers).collection

describe('toGitHubSponsorsResponse', () => {
  it('returns a typed upstream-error state instead of throwing', () => {
    const response = toGitHubSponsorsResponse(
      { _tag: 'unavailable', reason: 'upstream-error', errorTag: 'HttpError' },
      empty,
      '2026-01-01T00:00:00.000Z',
    )
    expect(response).toEqual({
      _tag: 'unavailable',
      reason: 'upstream-error',
      errorTag: 'HttpError',
      ...empty,
    })
  })

  it('returns the not-configured state with an empty collection', () => {
    const response = toGitHubSponsorsResponse({ _tag: 'unavailable', reason: 'not-configured' }, empty, '2026-01-01T00:00:00.000Z')
    expect(response).toMatchObject({ _tag: 'unavailable', reason: 'not-configured', sponsors: [] })
  })

  it('returns the available state with the fetched collection', () => {
    const collection = preparePublicSponsors([], tiers).collection
    const response = toGitHubSponsorsResponse(
      { _tag: 'available', collection, unmatchedOverrides: [] },
      empty,
      '2026-01-01T00:00:00.000Z',
    )
    expect(response).toMatchObject({ _tag: 'available', fetchedAt: '2026-01-01T00:00:00.000Z' })
  })
})

describe('preparePublicSponsors override reporting', () => {
  it('reports override keys that matched no sponsor', () => {
    const prepared = preparePublicSponsors(
      [{
        monthlyDollars: 50,
        privacyLevel: 'PUBLIC',
        sponsor: { avatarUrl: 'https://a.example.com/x', linkUrl: 'https://github.com/MassiveMonster', login: 'MassiveMonster', name: 'Massive Monster', websiteUrl: null },
      }],
      tiers,
      { 'MassiveMonster': { name: 'Kintell' }, 'Kintell-labs': { name: 'Kintell' } },
    )
    expect(prepared.unmatchedOverrides).toEqual(['Kintell-labs'])
    expect(prepared.collection.sponsors[0]?.name).toBe('Kintell')
  })

  it('reports no unmatched keys when every override matched', () => {
    const prepared = preparePublicSponsors(
      [{
        monthlyDollars: 50,
        privacyLevel: 'PUBLIC',
        sponsor: { avatarUrl: 'https://a.example.com/x', linkUrl: 'https://github.com/x', login: 'x', name: 'X', websiteUrl: null },
      }],
      tiers,
      { x: { name: 'Ex' } },
    )
    expect(prepared.unmatchedOverrides).toEqual([])
  })
})
