import { describe, expect, it } from 'vitest'
import { createOverrideUsage } from '../src/size-budget/override-usage'

const override = (fragment: string) => ({ fragment, bytes: 1024 })

describe('createOverrideUsage', () => {
  it('reports every fragment as unused before anything is measured', () => {
    const usage = createOverrideUsage([override('analytics'), override('server/plugins/sentry.ts')])

    expect(usage.unused()).toEqual(['analytics', 'server/plugins/sentry.ts'])
  })

  it('clears a fragment that a measured path contains', () => {
    const usage = createOverrideUsage([override('server/plugins/sentry.ts')])

    usage.use([{ path: '/app/server/plugins/sentry.ts' }])

    expect(usage.unused()).toEqual([])
  })

  it('clears a fragment that names a measured entry', () => {
    const usage = createOverrideUsage([override('analytics')])

    usage.use([{ path: '/app/app/plugins/tracking.ts', name: 'analytics' }])

    expect(usage.unused()).toEqual([])
  })

  it('clears a fragment that names the Nuxt module that registered an entry', () => {
    const usage = createOverrideUsage([override('@sentry/nuxt')])

    usage.use([{ path: '/app/.nuxt/sentry.mjs', owner: '@sentry/nuxt' }])

    expect(usage.unused()).toEqual([])
  })

  it('keeps a fragment that no measured entry matches', () => {
    const usage = createOverrideUsage([override('server/plugins/sentry.ts'), override('analytics')])

    usage.use([{ path: '/app/server/plugins/audit.ts' }])
    usage.use([{ path: '/app/app/plugins/analytics.client.ts', name: 'analytics' }])

    expect(usage.unused()).toEqual(['server/plugins/sentry.ts'])
  })

  it('matches a Windows path against a fragment written with forward slashes', () => {
    const usage = createOverrideUsage([override('server/plugins/sentry.ts')])

    usage.use([{ path: 'C:\\app\\server\\plugins\\sentry.ts' }])

    expect(usage.unused()).toEqual([])
  })
})
