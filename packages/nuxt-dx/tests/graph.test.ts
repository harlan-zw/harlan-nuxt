import type { CostTarget, GraphModule } from '../src/size-budget/graph'
import { describe, expect, it } from 'vitest'
import { measureCost } from '../src/size-budget/graph'

function mod(id: string, bytes: number, importedIds: string[] = []): GraphModule {
  return { id, bytes, importedIds }
}

function target(id: string): CostTarget {
  return { key: id, ids: [id] }
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

const TARGETS = [target('/app/plugins/analytics.ts'), target('/app/plugins/tracker.ts')]

function measure(modules = MODULES, targets = TARGETS) {
  return measureCost({ modules, targets, entryIds: ['/app/entry.js'] })
}

describe('measureCost', () => {
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
    const [analytics] = measure(modules, [...TARGETS, target('/app/plugins/extra.ts')])
    expect(analytics.exclusiveBytes).toBe(0)
    expect(analytics.totalBytes).toBe(1000)
  })

  it('reports a plugin with no exclusive dependencies at its own size', () => {
    const [, tracker] = measure()
    expect(tracker.totalBytes).toBe(5200)
  })

  it('skips targets that were tree-shaken out of the bundle', () => {
    expect(measure(MODULES, [...TARGETS, target('/app/plugins/gone.ts')])).toHaveLength(2)
  })

  it('ignores imports that never landed in the bundle', () => {
    const modules = [
      mod('/app/entry.js', 10, ['/app/plugins/a.ts']),
      mod('/app/plugins/a.ts', 10, ['node:crypto', '/node_modules/x/index.mjs']),
      mod('/node_modules/x/index.mjs', 30, ['external-package']),
    ]
    const [a] = measure(modules, [target('/app/plugins/a.ts')])
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
    const [a] = measure(modules, [target('/app/plugins/a.ts')])
    expect(a.totalBytes).toBe(80)
  })
})

// entry -> plugins.mjs -> { robots runtime, sitemap runtime }, both packages also carry a util file
const PACKAGES = [
  mod('/app/entry.js', 100, ['/build/plugins.mjs']),
  mod('/build/plugins.mjs', 50, ['/node_modules/robots/dist/plugin.mjs', '/node_modules/sitemap/dist/plugin.mjs']),
  mod('/node_modules/robots/dist/plugin.mjs', 400, ['/node_modules/robots/dist/util.mjs', '/node_modules/ufo/index.mjs']),
  mod('/node_modules/robots/dist/util.mjs', 600, ['/node_modules/parser/index.mjs']),
  mod('/node_modules/sitemap/dist/plugin.mjs', 300, ['/node_modules/ufo/index.mjs']),
  mod('/node_modules/parser/index.mjs', 50_000, []),
  mod('/node_modules/ufo/index.mjs', 9000, []),
]

const PACKAGE_TARGETS: CostTarget[] = [
  { key: 'robots', ids: ['/node_modules/robots/dist/plugin.mjs', '/node_modules/robots/dist/util.mjs'] },
  { key: 'sitemap', ids: ['/node_modules/sitemap/dist/plugin.mjs'] },
]

describe('measureCost with grouped targets', () => {
  it('charges a package for every file it ships', () => {
    const [robots] = measureCost({ modules: PACKAGES, targets: PACKAGE_TARGETS, entryIds: ['/app/entry.js'] })
    expect(robots.ownBytes).toBe(1000)
    expect(robots.totalBytes).toBe(51_000)
  })

  it('charges neither package for a dependency both reach', () => {
    const measured = measureCost({ modules: PACKAGES, targets: PACKAGE_TARGETS, entryIds: ['/app/entry.js'] })
    const charged = measured.flatMap(entry => entry.heaviestDependencies.map(dep => dep.id))
    expect(charged).not.toContain('/node_modules/ufo/index.mjs')
    expect(measured[1]!.totalBytes).toBe(300)
  })

  it('does not charge a package for the files of a sibling target', () => {
    const [robots] = measureCost({ modules: PACKAGES, targets: PACKAGE_TARGETS, entryIds: ['/app/entry.js'] })
    expect(robots.heaviestDependencies.map(dep => dep.id)).toEqual(['/node_modules/parser/index.mjs'])
  })
})
