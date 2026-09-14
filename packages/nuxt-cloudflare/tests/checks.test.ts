import { runChecks } from '@harlan-zw/nuxt-checkin/server'
import { describe, expect, it } from 'vitest'
import { defineD1Check } from '../src/checks'

describe('public D1 check', () => {
  it('proves a read rather than binding presence alone', async () => {
    const sql: string[] = []
    const event = { context: { cloudflare: { env: { DB: { prepare: (query: string) => {
      sql.push(query)
      return { first: async () => ({ checkin_ready: 1 }) }
    } } } } } }
    const report = await runChecks([defineD1Check({ id: 'd1.read', binding: 'DB' })], { event })
    expect(sql).toEqual(['SELECT 1 AS checkin_ready'])
    expect(report.results[0]?.result).toEqual({ _tag: 'Pass', evidence: { binding: 'DB', readable: true } })
  })

  it('keeps missing binding evidence explicit', async () => {
    expect((await runChecks([defineD1Check({ id: 'd1.read', binding: 'DB' })])).coverage).toBe('incomplete')
  })
})
