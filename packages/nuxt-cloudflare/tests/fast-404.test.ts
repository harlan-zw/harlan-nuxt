import type { HeaderEvent } from '../src/runtime/server/plugins/headers'
import { describe, expect, it, vi } from 'vitest'
import {
  classifyFast404Request,
  createFast404Response,
  DEFAULT_FAST_404_ALLOW_PREFIXES,
  resolveFast404Policy,
} from '../src/runtime/server/utils/fast-404'

describe('resolveFast404Policy', () => {
  it('stays disabled by default or when set to false', () => {
    expect(resolveFast404Policy(undefined)).toEqual({ _tag: 'disabled' })
    expect(resolveFast404Policy(false)).toEqual({ _tag: 'disabled' })
  })

  it('uses safe defaults when enabled with true', () => {
    expect(resolveFast404Policy(true)).toEqual({
      _tag: 'enabled',
      allowPrefixes: [],
      edgeCacheTtlSeconds: 300,
    })
  })

  it('normalizes custom prefixes and floors positive TTLs', () => {
    expect(resolveFast404Policy({
      allowPrefixes: ['feed.xml', ' /custom/ ', ''],
      edgeCacheTtlSeconds: 600.9,
    })).toEqual({
      _tag: 'enabled',
      allowPrefixes: ['/feed.xml', '/custom/'],
      edgeCacheTtlSeconds: 600,
    })
  })

  it('accepts zero TTL and rejects negative or non-finite TTLs', () => {
    expect(resolveFast404Policy({ edgeCacheTtlSeconds: 0 })).toMatchObject({
      _tag: 'enabled',
      edgeCacheTtlSeconds: 0,
    })
    expect(() => resolveFast404Policy({ edgeCacheTtlSeconds: -1 })).toThrow('edgeCacheTtlSeconds')
    expect(() => resolveFast404Policy({ edgeCacheTtlSeconds: Number.NaN })).toThrow('edgeCacheTtlSeconds')
  })
})

describe('classifyFast404Request', () => {
  it.each([
    '/',
    '/docs/getting-started',
    '/blog/v1.2/release',
    '/404.html',
    '/index.html',
    '/_nuxt/entry.abc123.js',
    '/_og/d/hero.png',
    '/_og-static-fonts/inter.woff2',
    '/__og-image__/image/og.png',
    '/_ipx/w_800/logo.png',
    '/_fonts/abc.woff2',
    '/_scripts/analytics.js',
    '/api/users.json',
    '/api/health',
    '/auth/callback',
    '/__nuxt_error',
    '/__nuxt_island/Card_123.json',
    '/__nuxt_content/docs/sql_dump.txt',
    '/__comark_content/rev123/navigation/docs',
    '/__ai-ready/llms.txt',
    '/__sitemap__/urls.json',
    '/__link-checker__/inspect',
    '/__skew/manifest.json',
    '/.well-known/agent-skills',
    '/.well-known/agent-skills/index.json',
    '/robots.txt',
    '/sitemap.xml',
    '/sitemap_index.xml',
    '/sitemap-docs.xml',
    '/llms.txt',
    '/llms-full.txt',
    '/SKILL.md',
    '/docs/guide.md',
    '/docs/guide/_payload.json',
    '/@vite/client',
    '/__nuxt_devtools__/client',
  ])('passes allowed or normal route %s', (pathname) => {
    expect(classifyFast404Request(pathname, 'GET')).toEqual({ _tag: 'pass' })
  })

  it.each([
    ['/.env', 'dotfile'],
    ['/.env.production', 'dotfile'],
    ['/.git/config', 'dotfile'],
    ['/.git/HEAD', 'dotfile'],
    ['/.htaccess', 'dotfile'],
    ['/docs/.env', 'dotfile'],
    ['/%2eenv', 'dotfile'],
    ['/api/../.env', 'dotfile'],
    ['/.well-known/agent-skills/.env', 'dotfile'],
    ['/.well-known/acme-challenge/missing', 'dotfile'],
    ['/wp-admin/install.php', 'cms-or-scanner'],
    ['/wp-login.php', 'cms-or-scanner'],
    ['/wp-content/uploads/shell.png', 'cms-or-scanner'],
    ['/wp-content/plugins/foo/readme.md', 'cms-or-scanner'],
    ['/xmlrpc.php', 'cms-or-scanner'],
    ['/phpmyadmin/index.php', 'cms-or-scanner'],
    ['/cgi-bin/test.cgi', 'cms-or-scanner'],
    ['/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php', 'cms-or-scanner'],
    ['/actuator/env', 'cms-or-scanner'],
    ['/login.php', 'script-extension'],
    ['/admin.aspx', 'script-extension'],
    ['/backup.sql', 'script-extension'],
    ['/config.bak', 'script-extension'],
    ['/server.ini', 'script-extension'],
    ['/apple-touch-icon-120x120-precomposed.png', 'static-extension'],
    ['/favicon.ico', 'static-extension'],
    ['/missing-bundle.js', 'static-extension'],
    ['/styles/old.css', 'static-extension'],
    ['/fonts/missing.woff2', 'static-extension'],
    ['/random.xml', 'static-extension'],
    ['/notes.txt', 'static-extension'],
    ['/config.json', 'static-extension'],
  ] as const)('rejects %s as %s', (pathname, reason) => {
    expect(classifyFast404Request(pathname, 'GET')).toEqual({ _tag: 'not-found', reason })
  })

  it('honours custom allowPrefixes without weakening dotfile traversal checks', () => {
    expect(classifyFast404Request('/feed.xml', 'GET', { allowPrefixes: ['/feed.xml'] })).toEqual({ _tag: 'pass' })
    expect(classifyFast404Request('/custom/report.pdf', 'GET', { allowPrefixes: ['/custom/'] })).toEqual({ _tag: 'pass' })
    expect(classifyFast404Request('/custom/.env', 'GET', { allowPrefixes: ['/custom/'] })).toEqual({ _tag: 'not-found', reason: 'dotfile' })
    expect(DEFAULT_FAST_404_ALLOW_PREFIXES).toContain('/__comark_content/')
  })

  it('handles POST scanner probes, OPTIONS preflights, and malformed percent encoding safely', () => {
    expect(classifyFast404Request('/wp-login.php', 'POST')).toEqual({ _tag: 'not-found', reason: 'cms-or-scanner' })
    expect(classifyFast404Request('/.env', 'POST')).toEqual({ _tag: 'not-found', reason: 'dotfile' })
    expect(classifyFast404Request('/wp-login.php', 'OPTIONS')).toEqual({ _tag: 'pass' })
    expect(classifyFast404Request('/%c0%af.php', 'GET')).toEqual({ _tag: 'not-found', reason: 'script-extension' })
  })
})

describe('createFast404Response and workers-cache compatibility', () => {
  it('emits plain-text 404 with no-store browser cache, edge TTL, and noindex', async () => {
    const response = createFast404Response('GET', 300)

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('cloudflare-cdn-cache-control')).toBe('public, max-age=300')
    expect(response.headers.get('x-robots-tag')).toBe('noindex')
    await expect(response.text()).resolves.toBe('Not Found')
  })

  it('omits body on HEAD and emits no-store on edge when TTL is 0', async () => {
    const response = createFast404Response('HEAD', 0)

    expect(response.status).toBe(404)
    expect(response.headers.get('cloudflare-cdn-cache-control')).toBe('no-store')
    await expect(response.text()).resolves.toBe('')
  })

  it('is left untouched by the workers-cache Nitro plugin', async () => {
    type Hook = (event: HeaderEvent, response?: { body: unknown }) => void | Promise<void>
    const hooks: Record<string, Hook> = {}
    vi.resetModules()
    vi.doMock('nitropack/runtime', () => ({
      defineNitroPlugin: (fn: (app: unknown) => void) => fn,
      useRuntimeConfig: () => ({ nuxtCloudflare: { htmlCacheMode: 'auto' } }),
    }))

    const plugin = (await import('../src/runtime/server/plugins/workers-cache')).default as unknown as
      (app: { hooks: { hook: (name: string, fn: Hook) => void } }) => void
    plugin({
      hooks: {
        hook: (name, fn) => {
          hooks[name] = fn
        },
      },
    })

    const response = createFast404Response('GET', 300)
    const event: HeaderEvent = {
      req: new Request('https://x.test/wp-login.php'),
      res: { status: response.status, headers: response.headers },
      path: '/wp-login.php',
    }
    hooks.request?.(event)
    // Middleware overwrites the request-hook floor with the fast-404 headers.
    event.res.headers.set('cache-control', 'no-store')
    event.res.headers.set('cloudflare-cdn-cache-control', 'public, max-age=300')
    await hooks.beforeResponse?.(event, { body: undefined })

    expect(event.res.headers.get('cache-control')).toBe('no-store')
    expect(event.res.headers.get('cloudflare-cdn-cache-control')).toBe('public, max-age=300')
    expect(event.res.headers.get('x-robots-tag')).toBe('noindex')
  })
})
