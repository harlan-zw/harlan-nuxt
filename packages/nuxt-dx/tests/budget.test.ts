import { describe, expect, it } from 'vitest'
import { budgetFor, smallestBudget } from '../src/size-budget/budget'
import { kilobytesToBytes } from '../src/size-budget/size'

const OVERRIDES = [
  { fragment: 'analytics', bytes: 60_000 },
  { fragment: 'server/plugins/queue', bytes: 5000 },
]

describe('smallestBudget', () => {
  it('is the default when no override is lower', () => {
    expect(smallestBudget(20_000, [{ fragment: 'analytics', bytes: 60_000 }])).toBe(20_000)
  })

  it('drops to the lowest override so a tightened budget still gets screened', () => {
    expect(smallestBudget(20_000, OVERRIDES)).toBe(5000)
  })

  it('is the default when there are no overrides', () => {
    expect(smallestBudget(20_000, [])).toBe(20_000)
  })
})

describe('budgetFor', () => {
  it('falls back to the default', () => {
    expect(budgetFor('client', { path: '/app/plugins/other.ts' }, 20_000, OVERRIDES)).toBe(20_000)
  })

  it('matches an override by plugin name', () => {
    expect(budgetFor('client', { path: '/app/plugins/heavy.ts', name: 'analytics' }, 20_000, OVERRIDES)).toBe(60_000)
  })

  it('matches an override by path fragment', () => {
    expect(budgetFor('nitro', { path: '/app/server/plugins/queue.ts' }, 20_000, OVERRIDES)).toBe(5000)
  })

  it('matches an override by the Nuxt module that registered the entry', () => {
    const overrides = [{ fragment: 'fixture-auth-module', bytes: 90_000 }]
    expect(budgetFor('client', { path: '/app/.nuxt/auth.mjs', owner: 'fixture-auth-module' }, 20_000, overrides)).toBe(90_000)
  })

  it('prefers a name match over a path match', () => {
    const overrides = [{ fragment: 'plugins/heavy', bytes: 1000 }, { fragment: 'analytics', bytes: 60_000 }]
    expect(budgetFor('client', { path: '/app/plugins/heavy.ts', name: 'analytics' }, 20_000, overrides)).toBe(60_000)
  })

  it('matches path fragments written with windows separators', () => {
    expect(budgetFor('nitro', { path: 'C:\\app\\server\\plugins\\queue.ts' }, 20_000, OVERRIDES)).toBe(5000)
  })
})

// Every app that installs one of these modules used to copy the same override into its
// config, which also hid a real regression inside that module behind the copy.
describe('budgetFor with a known heavy module', () => {
  const sentryBudget = kilobytesToBytes(400)

  it('covers the shared Sentry module, which registers the same plugin under its own name', () => {
    expect(budgetFor('nitro', { path: '/app/node_modules/@harlan-zw/nuxt-sentry/dist/runtime/server/plugins/sentry-cloudflare.js', owner: '@harlan-zw/nuxt-sentry' }, kilobytesToBytes(75), []))
      .toBe(sentryBudget)
  })

  it('raises the Nitro plugin budget for the Sentry Nitro plugin, by owner', () => {
    expect(budgetFor('nitro', { path: '/app/.nuxt/sentry-nitro.mjs', owner: '@sentry/nuxt' }, kilobytesToBytes(75), []))
      .toBe(sentryBudget)
  })

  it('raises it by path when the module reports no name', () => {
    expect(budgetFor('nitro', { path: '/app/node_modules/@sentry/nuxt/build/module/plugins/sentry.js' }, kilobytesToBytes(75), []))
      .toBe(sentryBudget)
  })

  it('leaves the client plugin budget alone, since only the Nitro plugin is heavy', () => {
    expect(budgetFor('client', { path: '/app/.nuxt/sentry-client.mjs', owner: '@sentry/nuxt' }, kilobytesToBytes(30), []))
      .toBe(kilobytesToBytes(30))
  })

  it('never lowers a budget the app set higher', () => {
    expect(budgetFor('nitro', { path: '/app/.nuxt/sentry-nitro.mjs', owner: '@sentry/nuxt' }, kilobytesToBytes(600), []))
      .toBe(kilobytesToBytes(600))
  })

  it('loses to an override the app wrote', () => {
    const overrides = [{ fragment: '@sentry/nuxt', bytes: 10_000 }]
    expect(budgetFor('nitro', { path: '/app/.nuxt/sentry-nitro.mjs', owner: '@sentry/nuxt' }, kilobytesToBytes(75), overrides))
      .toBe(10_000)
  })
})
