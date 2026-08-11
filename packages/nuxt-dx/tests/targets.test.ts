import { describe, expect, it } from 'vitest'
import { runtimeTargets } from '../src/size-budget/targets'

describe('runtimeTargets', () => {
  it('matches plugins and middleware into one disjoint runtime graph', () => {
    expect(runtimeTargets([
      { scope: 'client', path: '/app/plugins/analytics' },
      { scope: 'client-middleware', path: '/app/middleware/auth.ts', owner: '@fixture/auth' },
    ], ['/app/plugins/analytics.ts', '/app/middleware/auth.ts', '/app/entry.js']))
      .toEqual([
        { key: 'client:/app/plugins/analytics.ts', scope: 'client', path: '/app/plugins/analytics', ids: ['/app/plugins/analytics.ts'] },
        {
          key: 'client-middleware:/app/middleware/auth.ts',
          scope: 'client-middleware',
          path: '/app/middleware/auth.ts',
          owner: '@fixture/auth',
          ids: ['/app/middleware/auth.ts'],
        },
      ])
  })

  it('drops runtime entries that never landed in the bundle', () => {
    expect(runtimeTargets([{ scope: 'client', path: '/app/plugins/gone.ts' }], ['/app/entry.js'])).toEqual([])
  })

  it('charges one file once when it is registered twice', () => {
    expect(runtimeTargets([
      { scope: 'client', path: '/app/plugins/a.ts' },
      { scope: 'client', path: '/app/plugins/a' },
    ], ['/app/plugins/a.ts'])).toHaveLength(1)
  })
})
