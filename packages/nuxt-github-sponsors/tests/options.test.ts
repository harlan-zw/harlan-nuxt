import { describe, expect, it } from 'vitest'
import { detectSponsorToken, planSponsorDelivery, renderSponsorTierAugmentation } from '../src/options'

describe('detectSponsorToken', () => {
  it.each([
    ['the default env name', { NUXT_GITHUB_SPONSORS_TOKEN: ' secret ' }, 'NUXT_GITHUB_SPONSORS_TOKEN'],
    ['an aliased env name', { NUXT_GITHUB_AUTH_TOKEN: 'secret' }, 'NUXT_GITHUB_AUTH_TOKEN'],
  ])('reports a token in %s as present without carrying its value', (_label, env, tokenEnv) => {
    expect(detectSponsorToken(env, tokenEnv)).toEqual({ _tag: 'present' })
  })

  it('reports the env name it looked for when the token is absent', () => {
    expect(detectSponsorToken({ NUXT_GITHUB_SPONSORS_TOKEN: '  ' }, 'NUXT_GITHUB_SPONSORS_TOKEN'))
      .toEqual({ _tag: 'missing', tokenEnv: 'NUXT_GITHUB_SPONSORS_TOKEN' })
  })
})

describe('planSponsorDelivery', () => {
  it('prerenders when a build-time token exists', () => {
    expect(planSponsorDelivery('prerender', { _tag: 'present' })).toEqual({ _tag: 'prerender' })
  })

  it('refuses to prerender without a build-time token', () => {
    const plan = planSponsorDelivery('prerender', { _tag: 'missing', tokenEnv: 'NUXT_GITHUB_AUTH_TOKEN' })
    expect(plan._tag).toBe('prerender-skipped')
    if (plan._tag === 'prerender-skipped')
      expect(plan.warning).toContain('NUXT_GITHUB_AUTH_TOKEN')
  })

  it('keeps runtime and client modes independent of the build-time token', () => {
    expect(planSponsorDelivery('runtime', { _tag: 'missing', tokenEnv: 'X' })).toEqual({ _tag: 'runtime' })
    expect(planSponsorDelivery('client', { _tag: 'missing', tokenEnv: 'X' })).toEqual({ _tag: 'client' })
  })
})

describe('renderSponsorTierAugmentation', () => {
  it('types the tier keys from the configured tiers', () => {
    const contents = renderSponsorTierAugmentation([
      { key: 'top', minimumMonthlyDollars: 50 },
      { key: 'gold', minimumMonthlyDollars: 25 },
    ])
    expect(contents).toContain(`declare module '@harlan-zw/nuxt-github-sponsors/types'`)
    expect(contents).toContain('"top": true')
    expect(contents).toContain('"gold": true')
  })
})
