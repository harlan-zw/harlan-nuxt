import { describe, expect, it } from 'vitest'
import { checkReport, defineCheck, fail, pass, runChecks } from '../src/runtime/server'

const identity = { site: 'example.com', environment: 'production', deployment: 'v1' }
const now = new Date('2026-09-14T00:00:00Z')
const options = { identity, required: ['content'], now, maxAgeMs: 60_000 }

describe('external report checks', () => {
  it('rejects a missing report and a stale report', async () => {
    expect(checkReport(undefined, options)._tag).toBe('Unavailable')
    const report = await runChecks([defineCheck({ id: 'content', run: () => pass() })], { identity, now: new Date(now.getTime() - 120_000) })
    expect(checkReport(report, options)).toMatchObject({ _tag: 'Unavailable', reason: 'Check report is stale.' })
  })
  it('rejects wrong environments and missing required checks', async () => {
    const report = await runChecks([defineCheck({ id: 'content', run: () => pass() })], { identity, now })
    expect(checkReport({ ...report, identity: { ...identity, environment: 'preview' } }, options)._tag).toBe('Unavailable')
    expect(checkReport(report, { ...options, required: ['missing'] })._tag).toBe('Unavailable')
    expect(checkReport(report, options)._tag).toBe('Pass')
  })
  it('recomputes health instead of trusting the supplied aggregate', async () => {
    const report = await runChecks([defineCheck({ id: 'content', run: () => fail('Missing content.') })], { identity, now })
    expect(checkReport({ ...report, severity: 'pass' }, options)._tag).toBe('Fail')
  })
  it('rejects invalid payloads and duplicate results', async () => {
    const report = await runChecks([defineCheck({ id: 'content', run: () => pass() })], { identity, now })
    expect(checkReport({ ...report, results: [...report.results, ...report.results] }, options)._tag).toBe('Unavailable')
    expect(checkReport({ ...report, schemaVersion: 99 }, options)._tag).toBe('Unavailable')
    expect(checkReport({ ...report, results: [{ id: 'content', result: { _tag: 'unknown' } }] }, options)._tag).toBe('Unavailable')
  })
})
