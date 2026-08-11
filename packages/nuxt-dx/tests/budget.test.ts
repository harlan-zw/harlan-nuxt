import { describe, expect, it } from 'vitest'
import { budgetFor, smallestBudget } from '../src/size-budget/budget'

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
    expect(budgetFor('/app/plugins/other.ts', undefined, 20_000, OVERRIDES)).toBe(20_000)
  })

  it('matches an override by plugin name', () => {
    expect(budgetFor('/app/plugins/heavy.ts', 'analytics', 20_000, OVERRIDES)).toBe(60_000)
  })

  it('matches an override by path fragment', () => {
    expect(budgetFor('/app/server/plugins/queue.ts', undefined, 20_000, OVERRIDES)).toBe(5000)
  })

  it('prefers a name match over a path match', () => {
    const overrides = [{ fragment: 'plugins/heavy', bytes: 1000 }, { fragment: 'analytics', bytes: 60_000 }]
    expect(budgetFor('/app/plugins/heavy.ts', 'analytics', 20_000, overrides)).toBe(60_000)
  })

  it('matches path fragments written with windows separators', () => {
    expect(budgetFor('C:\\app\\server\\plugins\\queue.ts', undefined, 20_000, OVERRIDES)).toBe(5000)
  })
})
