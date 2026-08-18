import { describe, expect, it } from 'vitest'
import module from '../src/module'
import { resolveSponsorTiers } from '../src/options'

/** What Nuxt does with the module's declared defaults before `setup` sees them. */
async function resolveOptions(inline: Record<string, unknown>) {
  const nuxt = { options: { } } as never
  return await (module as unknown as { getOptions: (i: unknown, n: never) => Promise<{ tiers: never[] }> }).getOptions(inline, nuxt)
}

describe('tier defaults', () => {
  it('keeps only the tiers a site authored', async () => {
    const authored = [{ key: 'top', minimumMonthlyDollars: 100 }]
    const options = await resolveOptions({ login: 'harlan-zw', tiers: authored })
    expect(resolveSponsorTiers(options.tiers)).toEqual(authored)
  })

  it('falls back to the shipped tiers when a site authors none', async () => {
    const options = await resolveOptions({ login: 'harlan-zw' })
    expect(resolveSponsorTiers(options.tiers).map(tier => tier.key)).toEqual(['top', 'gold'])
  })
})
