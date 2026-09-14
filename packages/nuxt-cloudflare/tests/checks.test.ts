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

it('shares a D1 read for duplicate binding checks', async () => {
  let reads = 0
  const DB = { prepare: () => ({ first: async () => {
    reads++
    return { checkin_ready: 1 }
  } }) }
  const event = { context: { cloudflare: { env: { DB } } } }
  const report = await runChecks(['a', 'b'].map(id => defineD1Check({ id, binding: 'DB' })), { event })
  expect(reads).toBe(1)
  expect(report.collections).toMatchObject([{ requests: 1 }])
})
