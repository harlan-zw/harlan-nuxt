import { describe, expect, it } from 'vitest'
import {
  findHtmlCacheRouteRuleViolations,
  formatHtmlCacheRouteRuleViolations,
} from '../src/html-cache'
import { hasExplicitCachePolicy, withHtmlNoStoreHeaders } from '../src/runtime/server/utils/workers-cache'

describe('html cache route rules', () => {
  it('rejects every cache mechanism on HTML-capable routes', () => {
    const violations = findHtmlCacheRouteRuleViolations({
      '/': { swr: 60 },
      '/blog/**': { isr: 300 },
      '/docs/**': {
        headers: {
          'Cache-Control': 'no-cache',
          'Cloudflare-CDN-Cache-Control': 'public, max-age=3600',
        },
      },
      '/shop/**': { cache: { maxAge: 60 } },
    })

    expect(violations).toEqual([
      { _tag: 'html-cache-route-rule', route: '/', configPath: 'routeRules./.swr' },
      { _tag: 'html-cache-route-rule', route: '/blog/**', configPath: 'routeRules./blog/**.isr' },
      { _tag: 'html-cache-header', route: '/docs/**', configPath: 'routeRules./docs/**.headers.Cache-Control' },
      { _tag: 'html-cache-header', route: '/docs/**', configPath: 'routeRules./docs/**.headers.Cloudflare-CDN-Cache-Control' },
      { _tag: 'html-cache-route-rule', route: '/shop/**', configPath: 'routeRules./shop/**.cache' },
    ])
    expect(formatHtmlCacheRouteRuleViolations(violations)).toContain('routeRules./docs/**.headers.Cloudflare-CDN-Cache-Control')
  })

  it('allows cache rules on API and static asset routes', () => {
    expect(findHtmlCacheRouteRuleViolations({
      '/api/**': { cache: { maxAge: 60 } },
      '/_nuxt/**': { headers: { 'cache-control': 'public, immutable' } },
      '/fonts/**': { headers: { 'cache-control': 'public, immutable' } },
      '/sitemap.xml': { headers: { 'cache-control': 'public, max-age=60' } },
    })).toEqual([])
  })
})

describe('html response cache safety', () => {
  it('distinguishes explicit response policies from heuristic caching', () => {
    const headers = new Map<string, string>()
    expect(hasExplicitCachePolicy(name => headers.get(name))).toBe(false)
    headers.set('cloudflare-cdn-cache-control', 'public, max-age=60')
    expect(hasExplicitCachePolicy(name => headers.get(name))).toBe(true)
  })

  it('replaces every cache header with an explicit no-store policy', () => {
    expect(withHtmlNoStoreHeaders({
      'Cache-Control': 'public, max-age=3600',
      'CDN-Cache-Control': 'public, max-age=3600',
      'Cloudflare-CDN-Cache-Control': 'public, max-age=3600',
      'x-test': 'preserved',
    })).toEqual({
      'cache-control': 'private, no-store',
      'cloudflare-cdn-cache-control': 'no-store',
      'x-test': 'preserved',
    })
  })
})
