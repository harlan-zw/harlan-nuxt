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
    expect(new URL(urls[0]!).searchParams.get('query')).toBe('is:unresolved')
    expect(new URL(urls[0]!).searchParams.get('start')).toBe('1970-01-01T00:00:00.000Z')
    expect(new URL(urls[0]!).searchParams.get('project')).toBe('site')
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

it('checks older unresolved issues by default and scopes the environment', async () => {
  const urls: URL[] = []
  const request: typeof fetch = async (input) => {
    urls.push(new URL(String(input)))
    return new Response(JSON.stringify([{ id: '1', lastSeen: '2020-01-01T00:00:00Z' }]))
  }
  const report = await runChecks([defineSentryCheck({ ...options, environment: 'production', region: 'de' }, request)], { credentials: { sentry: 'secret' } })
  expect(report.results[0]?.result._tag).toBe('Warn')
  expect(urls[0]?.hostname).toBe('de.sentry.io')
  expect(urls[0]?.searchParams.get('query')).not.toContain('lastSeen:>=')
  expect(urls[0]?.searchParams.get('environment')).toBe('production')
})

it('shares identical Sentry requests within a run', async () => {
  let calls = 0
  const request: typeof fetch = async () => {
    calls++
    return new Response('[]')
  }
  const report = await runChecks([
    defineSentryCheck({ ...options, id: 'a' }, request),
    defineSentryCheck({ ...options, id: 'b' }, request),
  ], { credentials: { sentry: 'secret' } })
  expect(calls).toBe(1)
  expect(report.coverage).toBe('complete')
})

it('keeps known unresolved issues visible when later pages fail', async () => {
  let calls = 0
  const request: typeof fetch = async () => ++calls === 1
    ? new Response('[{"id":"12"}]', { headers: { link: '<ignored>; rel="next"; results="true"; cursor="next"' } })
    : new Response('', { status: 403 })
  const report = await runChecks([defineSentryCheck(options, request)], { credentials: { sentry: 'secret' } })
  expect(report).toMatchObject({ severity: 'warn', coverage: 'incomplete' })
  expect(report.results[0]?.result).toMatchObject({ _tag: 'Warn', coverage: 'incomplete', evidence: { issueIds: ['12'] } })
  expect(calls).toBe(2)
})

it('retries one rate-limited read without retrying authorization failures', async () => {
  let calls = 0
  const request: typeof fetch = async () => ++calls === 1
    ? new Response('', { status: 429, headers: { 'retry-after': '0' } })
    : new Response('[]')
  const report = await runChecks([defineSentryCheck(options, request)], { credentials: { sentry: 'secret' } })
  expect(report.coverage).toBe('complete')
  expect(calls).toBe(2)
})

it.each(['network', 'json'])('keeps issue evidence after a later %s failure', async (failure) => {
  let calls = 0
  const request: typeof fetch = async () => {
    if (++calls === 1)
      return new Response('[{"id":"12"}]', { headers: { link: '<ignored>; rel="next"; results="true"; cursor="next"' } })
    if (failure === 'network')
      throw new Error('private upstream detail')
    return new Response('not JSON')
  }
  const report = await runChecks([defineSentryCheck(options, request)], { credentials: { sentry: 'secret' } })
  expect(report).toMatchObject({ severity: 'warn', coverage: 'incomplete' })
  expect(report.results[0]?.result).toMatchObject({ evidence: { issueIds: ['12'] } })
  expect(JSON.stringify(report)).not.toContain('private upstream detail')
})
