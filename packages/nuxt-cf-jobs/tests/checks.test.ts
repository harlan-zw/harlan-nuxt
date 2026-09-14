import { DatabaseSync } from 'node:sqlite'
import { runChecks } from '@harlan-zw/nuxt-checkin/server'
import { describe, expect, it } from 'vitest'
import { defineQueueCheck } from '../src/checks'
import { backpressureSql } from '../src/cli/queries'

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

it('collects every queue once per database and keeps volume thresholds', async () => {
  let calls = 0
  const row = { ready: 99, reserved: 0, delayed: 0, oldest_available_at: 700, oldest_reserved_at: null }
  const DB = { prepare: () => ({ all: async () => {
    calls++
    return { success: true, meta: { rows_read: 20 }, results: [{ ...row, queue: 'indexing' }, { ...row, queue: 'sync', ready: 100 }] }
  } }) }
  const event = { context: { cloudflare: { env: { DB } } } }
  const checks = ['indexing', 'sync'].map(queue => defineQueueCheck({ ...options, id: queue, queue, failMinimumReady: 100 }))
  const report = await runChecks(checks, { event, now: new Date(1_000_000) })
  expect(report.results.map(r => r.result._tag)).toEqual(['Warn', 'Fail'])
  expect(calls).toBe(1)
  expect(report.collections).toMatchObject([{ requests: 1, rowsRead: 20 }])
})

it('uses the supplied observation time to separate due and future work', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE jobs (queue TEXT, reserved_at INTEGER, available_at INTEGER, completed_at INTEGER, failed_at INTEGER)')
    db.exec('INSERT INTO jobs VALUES (\'indexing\', NULL, 900, NULL, NULL), (\'indexing\', NULL, 1100, NULL, NULL)')
    const rows = db.prepare(backpressureSql(undefined, 1000)).all()
    expect(rows).toMatchObject([{ queue: 'indexing', ready: 1, delayed: 1, oldest_available_at: 900 }])
  }
  finally {
    db.close()
  }
})
