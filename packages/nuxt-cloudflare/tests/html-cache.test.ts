import { describe, expect, it } from 'vitest'
import {
  findHtmlCacheRouteRuleViolations,
  formatHtmlCacheRouteRuleViolations,
} from '../src/html-cache'
import { statedPolicy } from '../src/runtime/server/utils/workers-cache'

describe('html cache route rules', () => {
  it('warns for ambiguous routes and rejects only explicit HTML routes', () => {
    const violations = findHtmlCacheRouteRuleViolations({
      '/': { swr: 60 },
      '/blog/**': { isr: 300, prerender: true },
      '/docs/**': {
        headers: {
          'Cache-Control': 'no-cache',
          'Cloudflare-CDN-Cache-Control': 'public, max-age=3600',
        },
      },
      '/shop/**': { cache: { maxAge: 60 } },
    })

    expect(violations).toEqual([
      { _tag: 'html-cache-route-rule', severity: 'warning', route: '/', configPath: 'routeRules./.swr' },
      { _tag: 'html-cache-route-rule', severity: 'error', route: '/blog/**', configPath: 'routeRules./blog/**.isr' },
      { _tag: 'html-cache-header', severity: 'warning', route: '/docs/**', configPath: 'routeRules./docs/**.headers.Cache-Control' },
      { _tag: 'html-cache-header', severity: 'warning', route: '/docs/**', configPath: 'routeRules./docs/**.headers.Cloudflare-CDN-Cache-Control' },
      { _tag: 'html-cache-route-rule', severity: 'warning', route: '/shop/**', configPath: 'routeRules./shop/**.cache' },
    ])
    expect(formatHtmlCacheRouteRuleViolations(violations)).toContain('routeRules./docs/**.headers.Cloudflare-CDN-Cache-Control')
  })

  it('allows cache rules on internal, API, generated image, and static asset routes', () => {
    expect(findHtmlCacheRouteRuleViolations({
      '/_fonts/**': { cache: { maxAge: 60 } },
      '/_scripts/assets/**': { cache: { maxAge: 60 } },
      '/api/**': { cache: { maxAge: 60 } },
      '/mcp/server-card': { headers: { 'cache-control': 'public, max-age=3600' } },
      '/_nuxt/**': { headers: { 'cache-control': 'public, immutable' } },
      '/_og/d/**': { headers: { 'cache-control': 'public, max-age=3600' } },
      '/fonts/**': { headers: { 'cache-control': 'public, immutable' } },
      '/sitemap.xml': { headers: { 'cache-control': 'public, max-age=60' } },
    })).toEqual([])
  })

  it('allows a route with an explicit non-HTML content type', () => {
    expect(findHtmlCacheRouteRuleViolations({
      '/generated/**': {
        headers: {
          'cache-control': 'public, max-age=3600',
          'content-type': 'image/png',
        },
      },
    })).toEqual([])
  })

  it('allows an explicit private HTML cache policy', () => {
    expect(findHtmlCacheRouteRuleViolations({
      '/auth/**': {
        cache: false,
        headers: {
          'cache-control': 'private, no-store',
          'cloudflare-cdn-cache-control': 'no-store',
        },
      },
    })).toEqual([])
  })
})

describe('html response cache safety', () => {
  it('distinguishes explicit response policies from heuristic caching', () => {
    const headers = new Map<string, string>()
    expect(statedPolicy(name => headers.get(name))).toBe(false)
    headers.set('cloudflare-cdn-cache-control', 'public, max-age=60')
    expect(statedPolicy(name => headers.get(name))).toBe(true)
  })
})
