import { runChecks } from '@harlan-zw/nuxt-checkin/server'
import { describe, expect, it } from 'vitest'
import { defineQueueCheck } from '../src/checks'

const options = { id: 'queue.indexing', d1Binding: 'DB', queue: 'indexing', warnAfterSeconds: 100, failAfterSeconds: 200, staleAfterSeconds: 300 }

describe('public queue check', () => {
  it.each([
    [90, null, 'Pass'],
    [100, null, 'Warn'],
    [200, null, 'Fail'],
    [null, 300, 'Fail'],
    [null, null, 'Pass'],
  ])('grades due age %s and reservation age %s as %s', async (age, reservationAge, tag) => {
    const row = { queue: 'indexing', ready: age === null ? 0 : 1, reserved: reservationAge === null ? 0 : 1, delayed: 500, oldest_available_at: age === null ? null : 1000 - age, oldest_reserved_at: reservationAge === null ? null : 1000 - reservationAge }
    const event = { context: { cloudflare: { env: { DB: { prepare: () => ({ all: async () => ({ success: true, results: [row] }) }) } } } } }
    const report = await runChecks([defineQueueCheck(options)], { event, now: new Date(1_000_000) })
    expect(report.results[0]?.result._tag).toBe(tag)
  })

  it('reports absent D1 evidence as unavailable', async () => {
    expect((await runChecks([defineQueueCheck(options)])).coverage).toBe('incomplete')
  })

  it('rejects due work without its required timestamp', async () => {
    const row = { queue: 'indexing', ready: 1, reserved: 0, delayed: 0, oldest_available_at: null, oldest_reserved_at: null }
    const event = { context: { cloudflare: { env: { DB: { prepare: () => ({ all: async () => ({ results: [row] }) }) } } } } }
    expect((await runChecks([defineQueueCheck(options)], { event })).coverage).toBe('incomplete')
  })

  it('rejects inverted thresholds', () => {
    expect(() => defineQueueCheck({ ...options, warnAfterSeconds: 300 })).toThrow('warning threshold')
  })
})
