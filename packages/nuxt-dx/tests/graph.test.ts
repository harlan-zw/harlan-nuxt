import type { GraphModule } from '../src/size-budget/graph'
import { describe, expect, it } from 'vitest'
import { measurePluginCost } from '../src/size-budget/graph'

function mod(id: string, bytes: number, importedIds: string[] = []): GraphModule {
  return { id, bytes, importedIds }
}

// entry -> plugins.mjs -> { analytics, tracker }
// analytics exclusively owns chart + chart-core; tracker owns nothing exclusive
// vue is reachable from the entry directly, so no plugin is charged for it
const MODULES = [
  mod('/app/entry.js', 100, ['/build/plugins.mjs', '/node_modules/vue/index.mjs']),
  mod('/build/plugins.mjs', 50, ['/app/plugins/analytics.ts', '/app/plugins/tracker.ts']),
  mod('/app/plugins/analytics.ts', 1000, ['/node_modules/chart/index.mjs', '/node_modules/vue/index.mjs']),
  mod('/app/plugins/tracker.ts', 200, ['/node_modules/shared/index.mjs']),
  mod('/node_modules/chart/index.mjs', 60_000, ['/node_modules/chart-core/index.mjs']),
  mod('/node_modules/chart-core/index.mjs', 20_000, []),
  mod('/node_modules/shared/index.mjs', 5000, []),
  mod('/node_modules/vue/index.mjs', 90_000, []),
]

const TARGET_IDS = ['/app/plugins/analytics.ts', '/app/plugins/tracker.ts']

function measure(modules = MODULES, targetIds = TARGET_IDS) {
  return measurePluginCost({ modules, targetIds, entryIds: ['/app/entry.js'] })
}

describe('measurePluginCost', () => {
  it('charges a plugin for the modules only it pulls in', () => {
    const [analytics] = measure()
    expect(analytics.ownBytes).toBe(1000)
    expect(analytics.exclusiveBytes).toBe(80_000)
    expect(analytics.totalBytes).toBe(81_000)
  })

  it('does not charge a plugin for modules the app already ships', () => {
    const [analytics] = measure()
    expect(analytics.heaviestDependencies.map(dep => dep.id)).not.toContain('/node_modules/vue/index.mjs')
  })

  it('ranks the heaviest exclusive dependencies first', () => {
    const [analytics] = measure()
    expect(analytics.heaviestDependencies).toEqual([
      { id: '/node_modules/chart/index.mjs', bytes: 60_000 },
      { id: '/node_modules/chart-core/index.mjs', bytes: 20_000 },
    ])
  })

  it('splits a dependency shared between two plugins away from both', () => {
    const modules = [...MODULES, mod('/app/plugins/extra.ts', 10, ['/node_modules/chart/index.mjs'])]
    modules[1] = mod('/build/plugins.mjs', 50, ['/app/plugins/analytics.ts', '/app/plugins/tracker.ts', '/app/plugins/extra.ts'])
    const [analytics] = measure(modules, [...TARGET_IDS, '/app/plugins/extra.ts'])
    expect(analytics.exclusiveBytes).toBe(0)
    expect(analytics.totalBytes).toBe(1000)
  })

  it('reports a plugin with no exclusive dependencies at its own size', () => {
    const [, tracker] = measure()
    expect(tracker.totalBytes).toBe(5200)
  })

  it('skips targets that were tree-shaken out of the bundle', () => {
    expect(measure(MODULES, [...TARGET_IDS, '/app/plugins/gone.ts'])).toHaveLength(2)
  })

  it('ignores imports that never landed in the bundle', () => {
    const modules = [
      mod('/app/entry.js', 10, ['/app/plugins/a.ts']),
      mod('/app/plugins/a.ts', 10, ['node:crypto', '/node_modules/x/index.mjs']),
      mod('/node_modules/x/index.mjs', 30, ['external-package']),
    ]
    const [a] = measure(modules, ['/app/plugins/a.ts'])
    expect(a.totalBytes).toBe(40)
    expect(a.heaviestDependencies).toEqual([{ id: '/node_modules/x/index.mjs', bytes: 30 }])
  })

  it('survives a dependency cycle', () => {
    const modules = [
      mod('/app/entry.js', 10, ['/app/plugins/a.ts']),
      mod('/app/plugins/a.ts', 10, ['/node_modules/x/index.mjs']),
      mod('/node_modules/x/index.mjs', 30, ['/node_modules/y/index.mjs']),
      mod('/node_modules/y/index.mjs', 40, ['/node_modules/x/index.mjs']),
    ]
    const [a] = measure(modules, ['/app/plugins/a.ts'])
    expect(a.totalBytes).toBe(80)
  })
})
