import { describe, expect, it } from 'vitest'
import { matchTargetId, normalizeForMatch } from '../src/size-budget/match'

describe('normalizeForMatch', () => {
  it('drops extensions, queries, virtual prefixes and windows separators', () => {
    expect(normalizeForMatch('C:\\app\\plugins\\a.client.ts')).toBe('C:/app/plugins/a.client')
    expect(normalizeForMatch('/app/plugins/a.mjs?v=123')).toBe('/app/plugins/a')
    expect(normalizeForMatch('\0/app/plugins/a.vue')).toBe('/app/plugins/a')
  })
})

describe('matchTargetId', () => {
  const ids = ['/app/plugins/analytics.ts?v=1', '/app/plugins/other.mjs']

  it('matches an extensionless config path to the bundled module id', () => {
    expect(matchTargetId('/app/plugins/analytics', ids)).toBe('/app/plugins/analytics.ts?v=1')
  })

  it('returns undefined when the plugin never reached the bundle', () => {
    expect(matchTargetId('/app/plugins/missing.ts', ids)).toBeUndefined()
  })
})
