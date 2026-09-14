import { describe, expect, it } from 'vitest'
import { defineHttpCheck, defineReportCheck, runExternalChecks } from '../src/runtime/external'
import { runChecks } from '../src/runtime/server'

describe('external checks', () => {
  it('validates a server timestamp after receiving the response', async () => {
    const identity = { site: 'example.com', environment: 'production', deployment: 'v1' }
    const report = await runChecks([{ id: 'db', run: () => ({ _tag: 'Pass', evidence: {} }) }], { identity, now: new Date('2026-09-15T00:00:01Z') })
    const request = async (_url: unknown, init?: RequestInit) => {
      expect(init).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer secret' } })
      return new Response(JSON.stringify(report))
    }
    const check = defineReportCheck({ id: 'site.report', url: 'https://example.com/check', tokenEnv: 'TOKEN', deploymentEnv: 'DEPLOY', ...identity, required: ['db'], maxAgeMs: 5000 }, { request: request as typeof fetch, clock: () => new Date('2026-09-15T00:00:02Z') })
    const result = await runExternalChecks([check], { required: ['site.report'] }, { env: { TOKEN: 'secret', DEPLOY: 'v1' }, now: new Date('2026-09-15T00:00:00Z') })
    expect(result.report.coverage).toBe('complete')
    expect(result.exitCode).toBe(0)
  })
  it('rejects oversized responses and missing required checks', async () => {
    const check = defineHttpCheck({ id: 'home', url: 'https://example.com', maxBytes: 4 }, { request: (async () => new Response('too large')) as typeof fetch })
    const result = await runExternalChecks([check], { required: ['home', 'missing'] })
    expect(result.report.results.map(row => row.result._tag)).toEqual(['Unavailable', 'Unavailable'])
    expect(result.exitCode).toBe(2)
  })
})
