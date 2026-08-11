import type { PluginVerdict } from '../src/size-budget/budget'
import type { BudgetScope } from '../src/size-budget/report'
import { stripAnsi } from 'consola/utils'
import { describe, expect, it } from 'vitest'
import { displayId, formatBudgetReport } from '../src/size-budget/report'

describe('displayId', () => {
  it('shortens project files to a root-relative path', () => {
    expect(displayId('/app/plugins/analytics.ts', '/app')).toBe('plugins/analytics.ts')
  })

  it('shortens dependencies to their package path', () => {
    expect(displayId('/app/node_modules/.pnpm/chart@1/node_modules/chart/dist/index.mjs', '/app')).toBe('chart/dist/index.mjs')
  })

  it('strips rollup virtual prefixes and queries', () => {
    expect(displayId('\0/app/plugins/a.ts?v=1', '/app')).toBe('plugins/a.ts')
  })
})

const verdict: PluginVerdict = {
  path: '/app/plugins/analytics.ts',
  budgetBytes: 20_480,
  measurement: {
    id: '/app/plugins/analytics.ts',
    ownBytes: 1024,
    exclusiveBytes: 81_920,
    exclusiveCount: 1,
    totalBytes: 82_944,
    heaviestDependencies: [{ id: '/app/node_modules/chart/index.mjs', bytes: 81_920 }],
  },
}

/** Colours are terminal dressing; assert on the text underneath. */
function report(over: PluginVerdict[], scope: BudgetScope = 'client'): string {
  return stripAnsi(formatBudgetReport(scope, over, '/app'))
}

describe('formatBudgetReport', () => {
  it('says which bundle the budget applies to', () => {
    expect(report([verdict])).toContain('1 Nuxt plugin over budget in the client bundle')
    expect(report([verdict, verdict], 'nitro')).toContain('2 Nitro plugins over budget in the server bundle')
  })

  it('states the overshoot, not just the total', () => {
    expect(report([verdict])).toContain('81 kB bundled, 61 kB over the 20 kB budget')
  })

  it('breaks the total down so the listed sizes account for every byte', () => {
    const lines = report([verdict])
    expect(lines).toContain('1 kB  the plugin file')
    expect(lines).toContain('80 kB  chart/index.mjs')
  })

  it('leads with the plugin name but keeps the file visible', () => {
    expect(report([{ ...verdict, name: 'analytics' }])).toContain('analytics  plugins/analytics.ts')
  })

  it('suggests an override keyed by name, rounded up past the current size', () => {
    expect(report([{ ...verdict, name: 'analytics' }])).toContain('nuxtDx.sizeBudget.overridesKb = { \'analytics\': 81 }')
  })

  it('falls back to a path key when the plugin is unnamed', () => {
    expect(report([verdict])).toContain('{ \'plugins/analytics.ts\': 81 }')
  })

  it('lists every offender in one override snippet', () => {
    expect(report([{ ...verdict, name: 'analytics' }, { ...verdict, name: 'tracker' }]))
      .toContain('{ \'analytics\': 81, \'tracker\': 81 }')
  })

  it('accounts for dependencies it did not list', () => {
    const truncated: PluginVerdict = {
      ...verdict,
      measurement: { ...verdict.measurement, exclusiveCount: 4, exclusiveBytes: 100_000 },
    }
    expect(report([truncated])).toContain('17.7 kB  across 3 more modules')
  })

  it('does not mention hidden modules when the list is complete', () => {
    expect(report([verdict])).not.toContain('more module')
  })

  it('points at a concrete fix', () => {
    expect(report([verdict])).toContain('await import()')
  })

  it('stays compact for a single offender', () => {
    expect(report([verdict]).split('\n')).toHaveLength(9)
  })
})
