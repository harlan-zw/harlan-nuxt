import { describe, expect, it } from 'vitest'
import { moduleOwnerOf, moduleRoot, packageDirOf } from '../src/size-budget/module-owner'

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

describe('moduleOwnerOf', () => {
  it('finds the module that registered a runtime entry', () => {
    expect(moduleOwnerOf('/app/node_modules/@nuxtjs/robots/dist/runtime/plugin.js', OWNERS)).toBe('robots')
  })

  it('leaves files no module owns unattributed', () => {
    expect(moduleOwnerOf('/app/node_modules/ufo/dist/index.mjs', OWNERS)).toBeUndefined()
  })

  it('does not let a package claim a sibling with a longer name', () => {
    expect(moduleOwnerOf('/app/node_modules/@nuxtjs/robots-extra/dist/index.mjs', OWNERS)).toBeUndefined()
  })

  it('matches a single-file module against itself', () => {
    expect(moduleOwnerOf('/app/modules/analytics.ts', OWNERS)).toBe('analytics')
  })

  it('gives a nested package to the module that ships it', () => {
    const owners = [
      { name: 'outer', root: '/app/node_modules/outer' },
      { name: 'inner', root: '/app/node_modules/outer/node_modules/inner' },
    ]
    expect(moduleOwnerOf('/app/node_modules/outer/node_modules/inner/index.js', owners)).toBe('inner')
  })

  it('matches rollup ids carrying a query', () => {
    expect(moduleOwnerOf('\0/app/node_modules/@nuxtjs/robots/dist/runtime/plugin.js?v=abc', OWNERS)).toBe('robots')
  })
})
