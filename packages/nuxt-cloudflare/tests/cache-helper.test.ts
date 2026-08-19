import { describe, expect, it } from 'vitest'
import { edgeCache, NO_STORE } from '../src/cache'
import {
  clampSharedCacheSeconds,
  sharedCacheSeconds,
  staleDirectivesAreDisabled,
  statedPolicy,
} from '../src/runtime/server/utils/workers-cache'

const edgeOf = (rule: { headers: Record<string, string> }) => rule.headers['cloudflare-cdn-cache-control']!

describe('edgeCache', () => {
  it('gives the edge a lifetime and leaves browsers to the floor', () => {
    expect(edgeCache({ maxAge: 60 })).toEqual({
      headers: { 'cloudflare-cdn-cache-control': 'public, max-age=60' },
    })
  })

  it('carries the stale windows', () => {
    expect(edgeOf(edgeCache({ maxAge: 3600, staleWhileRevalidate: 86_400, staleIfError: 86_400 })))
      .toBe('public, max-age=3600, stale-while-revalidate=86400, stale-if-error=86400')
  })

  it('lets browsers revalidate while the edge answers', () => {
    expect(edgeCache({ maxAge: 3600, browser: 'revalidate' }).headers['cache-control'])
      .toBe('public, max-age=0')
  })

  it('gives browsers a lifetime of their own when asked', () => {
    expect(edgeCache({ maxAge: 300, browser: { maxAge: 300 } }).headers['cache-control'])
      .toBe('public, max-age=300')
    expect(edgeCache({ maxAge: 300, browser: { maxAge: 300, immutable: true } }).headers['cache-control'])
      .toBe('public, max-age=300, immutable')
  })

  it('qualifies private so a cookie-setting response is still storable', () => {
    const rule = edgeCache({ maxAge: 3600, browser: 'revalidate', dropSetCookie: true })

    expect(edgeOf(rule)).toBe('public, max-age=3600, private="set-cookie"')
    expect(rule.headers['cache-control']).toBe('public, max-age=0, private="set-cookie"')
  })

  it('refuses a lifetime that means nothing', () => {
    expect(() => edgeCache({ maxAge: 0 })).toThrow(/positive maxAge/)
    expect(() => edgeCache({ maxAge: -1 })).toThrow(/positive maxAge/)
    expect(() => edgeCache({ maxAge: Number.NaN })).toThrow(/positive maxAge/)
  })

  it('offers an explicit way to say never', () => {
    expect(NO_STORE.headers['cache-control']).toBe('private, no-store')
    expect(sharedCacheSeconds(NO_STORE.headers['cache-control'])).toBeNull()
  })
})

// The reason this helper exists, and the reason it lives in this package rather
// than in each site: its output has to survive the same package's parser and
// clamp. These assertions are what caught the clamp inventing an `s-maxage`.
describe('round trip through the module that will read it', () => {
  const cases: { label: string, options: Parameters<typeof edgeCache>[0] }[] = [
    { label: 'plain', options: { maxAge: 60 } },
    { label: 'with stale windows', options: { maxAge: 3600, staleWhileRevalidate: 86_400, staleIfError: 86_400 } },
    { label: 'browser revalidates', options: { maxAge: 3600, staleWhileRevalidate: 86_400, browser: 'revalidate' } },
    { label: 'browser caches', options: { maxAge: 300, browser: { maxAge: 300 } } },
    { label: 'cookie dropped', options: { maxAge: 21_600, browser: 'revalidate', dropSetCookie: true } },
  ]

  it.each(cases)('$label is read back as the lifetime it declared', ({ options }) => {
    const expected = options.maxAge + (options.staleWhileRevalidate ?? 0)

    expect(sharedCacheSeconds(edgeOf(edgeCache(options)))).toBe(expected)
  })

  it.each(cases)('$label is recognised as a stated policy', ({ options }) => {
    const headers = edgeCache(options).headers

    expect(statedPolicy(name => headers[name])).toBe(true)
  })

  // `s-maxage` implies `proxy-revalidate` on Cloudflare, which disables both
  // stale directives. The helper must never emit one, and the clamp must never
  // add one to what the helper produced.
  it.each(cases)('$label never emits s-maxage, before or after clamping', ({ options }) => {
    const edge = edgeOf(edgeCache(options))

    expect(edge).not.toContain('s-maxage')
    expect(clampSharedCacheSeconds(edge, 600)).not.toContain('s-maxage')
  })

  it.each(cases)('$label never asks for stale serving Cloudflare would ignore', ({ options }) => {
    expect(staleDirectivesAreDisabled(edgeOf(edgeCache(options)))).toBe(false)
  })

  it.each(cases)('$label stays inside a ceiling once clamped', ({ options }) => {
    const clamped = clampSharedCacheSeconds(edgeOf(edgeCache(options)), 600)

    expect(sharedCacheSeconds(clamped)).toBeLessThanOrEqual(600)
  })
})
