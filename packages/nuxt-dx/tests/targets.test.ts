import { describe, expect, it } from 'vitest'
import { moduleTargets, pluginTargets } from '../src/size-budget/targets'

describe('pluginTargets', () => {
  it('matches a plugin path to its bundled id', () => {
    expect(pluginTargets(['/app/plugins/analytics'], ['/app/plugins/analytics.ts', '/app/entry.js']))
      .toEqual([{ key: '/app/plugins/analytics.ts', path: '/app/plugins/analytics', ids: ['/app/plugins/analytics.ts'] }])
  })

  it('drops plugins that never landed in the bundle', () => {
    expect(pluginTargets(['/app/plugins/gone.ts'], ['/app/entry.js'])).toEqual([])
  })

  it('charges a plugin registered twice only once', () => {
    expect(pluginTargets(['/app/plugins/a.ts', '/app/plugins/a'], ['/app/plugins/a.ts'])).toHaveLength(1)
  })
})

describe('moduleTargets', () => {
  const owners = [{ name: '@nuxtjs/robots', root: '/app/node_modules/@nuxtjs/robots' }]

  it('charges a module for the package it ships from', () => {
    expect(moduleTargets(owners, ['/app/node_modules/@nuxtjs/robots/dist/runtime/plugin.js', '/app/entry.js']))
      .toEqual([{
        key: '@nuxtjs/robots',
        path: '/app/node_modules/@nuxtjs/robots',
        name: '@nuxtjs/robots',
        ids: ['/app/node_modules/@nuxtjs/robots/dist/runtime/plugin.js'],
      }])
  })

  it('skips a module that bundled nothing', () => {
    expect(moduleTargets(owners, ['/app/entry.js'])).toEqual([])
  })

  it('falls back to the package path when the module declares no name', () => {
    const [target] = moduleTargets([{ root: '/app/modules/analytics' }], ['/app/modules/analytics/index.ts'])
    expect(target!.key).toBe('/app/modules/analytics')
    expect(target!.name).toBeUndefined()
  })
})
