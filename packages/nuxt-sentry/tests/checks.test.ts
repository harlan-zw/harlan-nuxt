import { runChecks } from '@harlan-zw/nuxt-checkin/server'
import { describe, expect, it } from 'vitest'
import { defineSentryCheck } from '../src/checks'

const options = { id: 'sentry.issues', org: 'example', project: 'site' }

describe('public Sentry check', () => {
  it('paginates and deduplicates issue evidence', async () => {
    const urls: string[] = []
    const request: typeof fetch = async (url) => {
      urls.push(String(url))
      return urls.length === 1
        ? new Response(JSON.stringify([{ id: '12' }]), { headers: { link: '<ignored>; rel="next"; results="true"; cursor="next"' } })
        : new Response(JSON.stringify([{ id: '12' }, { id: '13' }]))
    }
    const report = await runChecks([defineSentryCheck(options, request)], { credentials: { sentry: 'secret' }, now: new Date('2026-09-14T00:00:00Z') })
    expect(report.results[0]?.result).toMatchObject({ _tag: 'Warn', evidence: { issueIds: ['12', '13'], count: 2 } })
    expect(new URL(urls[1]!).searchParams.get('cursor')).toBe('next')
    expect(new URL(urls[0]!).searchParams.get('query')).toBe('is:unresolved lastSeen:>=2026-08-31T00:00:00.000Z lastSeen:<=2026-09-14T00:00:00.000Z')
    expect(JSON.stringify(report)).not.toContain('secret')
  })

  it('refuses a complete verdict when pagination hits its limit', async () => {
    const request: typeof fetch = async () => new Response('[]', { headers: { link: '<ignored>; rel="next"; results="true"; cursor="next"' } })
    const report = await runChecks([defineSentryCheck({ ...options, maxPages: 1 }, request)], { credentials: { sentry: 'secret' } })
    expect(report.coverage).toBe('incomplete')
  })

  it('never requests Sentry without credentials', async () => {
    let calls = 0
    const request: typeof fetch = async () => {
      calls++
      return new Response('[]')
    }
    expect((await runChecks([defineSentryCheck(options, request)])).coverage).toBe('incomplete')
    expect(calls).toBe(0)
  })
})
