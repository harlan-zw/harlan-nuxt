import { describe, expect, it } from 'vitest'
import { sizeBudgetRollupPlugin } from '../src/size-budget/rollup'

describe('sizeBudgetRollupPlugin', () => {
  it('only measures the Vite environment it targets', async () => {
    const plugin = sizeBudgetRollupPlugin({
      scope: 'modules',
      environment: 'client',
      targets: () => [],
      onMeasured: () => {},
    })
    const appliesTo = Reflect.get(plugin, 'applyToEnvironment') as (environment: { name: string }) => boolean

    expect(await appliesTo({ name: 'client' })).toBe(true)
    expect(await appliesTo({ name: 'ssr' })).toBe(false)
  })
})
