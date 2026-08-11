import { describe, expect, it } from 'vitest'
import { groupByOwner, moduleRoot, packageDirOf } from '../src/size-budget/module-packages'

describe('packageDirOf', () => {
  it('finds the package a dependency file ships from', () => {
    expect(packageDirOf('/app/node_modules/ufo/dist/index.mjs')).toBe('/app/node_modules/ufo')
  })

  it('keeps both segments of a scoped package', () => {
    expect(packageDirOf('/app/node_modules/@nuxtjs/robots/dist/module.mjs')).toBe('/app/node_modules/@nuxtjs/robots')
  })

  it('resolves past the pnpm store to the real package folder', () => {
    expect(packageDirOf('/app/node_modules/.pnpm/@nuxtjs+robots@5.5.4_magicast@0.3.5/node_modules/@nuxtjs/robots/dist/runtime/plugin.js'))
      .toBe('/app/node_modules/.pnpm/@nuxtjs+robots@5.5.4_magicast@0.3.5/node_modules/@nuxtjs/robots')
  })

  it('picks the nested copy when a package bundles its own dependencies', () => {
    expect(packageDirOf('/app/node_modules/a/node_modules/b/index.js')).toBe('/app/node_modules/a/node_modules/b')
  })

  it('refuses the pnpm store itself', () => {
    expect(packageDirOf('/app/node_modules/.pnpm/ufo@1.5.4/node_modules')).toBeUndefined()
  })

  it('refuses a bare scope folder', () => {
    expect(packageDirOf('/app/node_modules/@nuxtjs')).toBeUndefined()
  })

  it('has no package for project files', () => {
    expect(packageDirOf('/app/modules/analytics/index.ts')).toBeUndefined()
  })

  it('reads windows paths and rollup ids', () => {
    expect(packageDirOf('\0C:\\app\\node_modules\\ufo\\dist\\index.mjs?v=1')).toBe('C:/app/node_modules/ufo')
  })
})

describe('moduleRoot', () => {
  it('is the whole package for a published module', () => {
    expect(moduleRoot('/app/node_modules/.pnpm/@nuxtjs+robots@5.5.4/node_modules/@nuxtjs/robots/dist/module.mjs'))
      .toBe('/app/node_modules/.pnpm/@nuxtjs+robots@5.5.4/node_modules/@nuxtjs/robots')
  })

  it('is the folder for a local module written as a directory', () => {
    expect(moduleRoot('/app/modules/analytics/index.ts')).toBe('/app/modules/analytics')
    expect(moduleRoot('/app/modules/analytics/module.ts')).toBe('/app/modules/analytics')
  })

  it('is the file alone for a single-file local module, so it cannot claim its siblings', () => {
    expect(moduleRoot('/app/modules/analytics.ts')).toBe('/app/modules/analytics.ts')
  })
})

const OWNERS = [
  { name: 'robots', root: '/app/node_modules/@nuxtjs/robots' },
  { name: 'analytics', root: '/app/modules/analytics.ts' },
]

describe('groupByOwner', () => {
  it('collects every bundled file under a package', () => {
    const [robots] = groupByOwner(OWNERS, [
      '/app/node_modules/@nuxtjs/robots/dist/runtime/plugin.js',
      '/app/node_modules/@nuxtjs/robots/dist/runtime/util.js',
      '/app/node_modules/ufo/dist/index.mjs',
    ])
    expect(robots!.ids).toHaveLength(2)
  })

  it('leaves files no module owns unattributed', () => {
    expect(groupByOwner(OWNERS, ['/app/node_modules/ufo/dist/index.mjs'])).toEqual([])
  })

  it('does not let a package claim a sibling with a longer name', () => {
    expect(groupByOwner(OWNERS, ['/app/node_modules/@nuxtjs/robots-extra/dist/index.mjs'])).toEqual([])
  })

  it('matches a single-file module against itself', () => {
    const [analytics] = groupByOwner(OWNERS, ['/app/modules/analytics.ts', '/app/modules/other.ts'])
    expect(analytics!.ids).toEqual(['/app/modules/analytics.ts'])
  })

  it('gives a nested package to the module that ships it', () => {
    const owners = [
      { name: 'outer', root: '/app/node_modules/outer' },
      { name: 'inner', root: '/app/node_modules/outer/node_modules/inner' },
    ]
    const grouped = groupByOwner(owners, ['/app/node_modules/outer/node_modules/inner/index.js'])
    expect(grouped).toEqual([{ owner: owners[1], ids: ['/app/node_modules/outer/node_modules/inner/index.js'] }])
  })

  it('merges two entries for the same module name', () => {
    const owners = [
      { name: 'robots', root: '/app/node_modules/@nuxtjs/robots' },
      { name: 'robots', root: '/app/modules/robots' },
    ]
    const grouped = groupByOwner(owners, ['/app/node_modules/@nuxtjs/robots/index.js', '/app/modules/robots/index.js'])
    expect(grouped).toHaveLength(1)
    expect(grouped[0]!.ids).toHaveLength(2)
  })

  it('matches rollup ids carrying a query', () => {
    const [robots] = groupByOwner(OWNERS, ['/app/node_modules/@nuxtjs/robots/dist/runtime/plugin.js?v=abc'])
    expect(robots!.ids).toEqual(['/app/node_modules/@nuxtjs/robots/dist/runtime/plugin.js?v=abc'])
  })
})
