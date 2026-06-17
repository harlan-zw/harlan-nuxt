// @vitest-environment node

import { resolve } from 'node:path'
import { $fetch, setup } from '@nuxt/test-utils/e2e'
import { describe, expect, it } from 'vitest'

// E2E / Nuxt-runtime tests for `nuxt-use-query`. Boots the fixture Nuxt
// app via @nuxt/test-utils so the integration paths the unit tests can't
// cover are actually exercised against a real Nuxt + Nitro:
//
//   1. The module's `addImports` registers the composables app-wide.
//   2. `useQueryCache()` attaches per-Nuxt-app state — same instance per
//      request, no module-level Maps.
//   3. `useNuxtQuery` round-trips through Nitro and stamps the cache.
//
// We also tried the lighter `// @vitest-environment nuxt` runtime mode
// (see memory: project_pro_query_wrapper for the full post-mortem). It
// requires `defineVitestConfig` + `environmentOptions.nuxt.rootDir`, which
// rewires global auto-imports to real Nuxt for *all* test files — breaking
// 60+ existing tests that rely on undefined/stubbable globals. Without
// touching every existing test the lighter env isn't viable in this repo.
// The e2e `setup()` path is the working compromise: real Nuxt + real Nitro,
// no global side effects.

await setup({
  rootDir: resolve(__dirname, './fixture'),
  server: true,
  browser: false,
})

interface Probe {
  a: { value: string, call: number } | null
  appContextFetch: { source: string }
  b: { value: string, call: number } | null
  cachedManualWrite: { ok: boolean } | undefined
  cacheKeys: string[]
  cacheSameInstance: boolean
  hasAutoImports: boolean
  mutationMethod: string
  rpcDefault: { value: string, call: number }
  rpcDirect: { value: string, call: number }
  rpcKey: string
  rpcQuery: { value: string, call: number } | null
}

interface TelemetryStore {
  duplicates: Array<{ count?: number, threshold?: number, url?: string }>
  fetches: Array<{ request?: string, url?: string }>
  nested: Array<{ depth?: number, threshold?: number, url?: string }>
  recursive: Array<{ depth?: number, stack?: string[], url?: string }>
  slowFetches: unknown[]
  summaries: Array<{
    fetches?: number
    request?: string
    timeline?: Array<{ offsetMs?: number, url?: string }>
  }>
  timeouts: Array<{ request?: string, timeoutMs?: number, url?: string }>
  waterfalls: unknown[]
}

async function readProbe(): Promise<Probe> {
  const html = await $fetch('/') as string
  const match = html.match(/<pre id="probe">([^<]+)<\/pre>/)
  if (!match)
    throw new Error(`probe not found in HTML:\n${html.slice(0, 500)}`)
  return JSON.parse(match[1]!.replace(/&quot;/g, '"')) as Probe
}

describe('nuxt-use-query · e2e', () => {
  it('registers auto-imports module-wide', async () => {
    const probe = await readProbe()
    expect(probe.hasAutoImports).toBe(true)
  })

  it('useNuxtQuery fetches the endpoint during SSR', async () => {
    const probe = await readProbe()
    expect(probe.a?.value).toBe('a')
    expect(probe.b?.value).toBe('b')
    expect(probe.a?.call).toBeGreaterThan(0)
    expect(probe.b?.call).toBeGreaterThan(0)
  })

  it('useQueryCache returns a single mutable instance per Nuxt app', async () => {
    const probe = await readProbe()
    expect(probe.cacheSameInstance).toBe(true)
    expect(probe.cacheKeys).toContain('manual-stamp-a')
    expect(probe.cacheKeys).toContain('manual-stamp-b')
  })

  it('registers RPC auto-imports through the module surface', async () => {
    const probe = await readProbe()
    expect(probe.rpcKey).toBe('fixture:rpc-query')
    expect(probe.rpcQuery?.value).toBe('rpc-query')
    expect(probe.rpcDirect.value).toBe('rpc-direct')
    expect(probe.rpcDefault.value).toBe('rpc-default')
    expect(probe.appContextFetch).toEqual({ source: 'nuxt-app' })
    expect(probe.mutationMethod).toBe('DELETE')
    expect(probe.cachedManualWrite).toEqual({ ok: true })
  })

  it('registers fetch telemetry through the module option and Nitro plugin', async () => {
    await $fetch('/api/telemetry', { query: { reset: '1' } })

    await readProbe()

    const telemetry = await $fetch<TelemetryStore>('/api/telemetry')
    expect(telemetry.fetches.some(event => event.request === 'GET /' && event.url === '/api/echo')).toBe(true)
    expect(telemetry.fetches.some(event => event.url === '/api/app-context-fetch')).toBe(true)
    const homeSummary = telemetry.summaries.find(event => event.request === 'GET /' && (event.fetches ?? 0) >= 4)
    expect(homeSummary).toBeDefined()
    const redactedEcho = homeSummary?.timeline?.find(entry => entry.url?.startsWith('/api/echo?') && entry.url.includes('v=a'))
    expect(redactedEcho?.url).toContain('token=')
    expect(redactedEcho?.url).toContain('redacted')
    expect(homeSummary?.timeline?.some(entry => entry.url?.includes('fixture-secret-token'))).toBe(false)
    expect(homeSummary?.timeline?.some(entry => entry.url === '/api/echo?v=b')).toBe(true)
    expect(homeSummary?.timeline?.some(entry => entry.url === '/api/echo?v=rpc-default')).toBe(true)
  })

  it('applies the configured default server fetch timeout and emits a hook', async () => {
    await $fetch('/api/telemetry', { query: { reset: '1' } })

    const result = await $fetch<{ timedOut: boolean }>('/api/telemetry-timeout')
    expect(result.timedOut).toBe(true)

    const telemetry = await $fetch<TelemetryStore>('/api/telemetry')
    expect(telemetry.timeouts.some(event =>
      event.url?.endsWith('/api/telemetry-delay')
      && event.timeoutMs === 100,
    )).toBe(true)
  })

  it('emits internal duplicate and nested-depth fetch hooks', async () => {
    await $fetch('/api/telemetry', { query: { reset: '1' } })

    await $fetch('/api/telemetry-duplicates')
    await $fetch('/api/telemetry-depth')

    const telemetry = await $fetch<TelemetryStore>('/api/telemetry')
    expect(telemetry.duplicates.some(event =>
      event.url === '/api/echo'
      && event.count === 2
      && event.threshold === 2,
    )).toBe(true)
    expect(telemetry.nested.some(event =>
      event.url === '/api/telemetry-depth/two'
      && event.depth === 3
      && event.threshold === 3,
    )).toBe(true)

    await $fetch('/api/telemetry', { query: { reset: '1' } })
    await $fetch('/api/telemetry-recursive')

    const recursiveTelemetry = await $fetch<TelemetryStore>('/api/telemetry')
    expect(recursiveTelemetry.recursive.some(event =>
      event.url === '/api/telemetry-recursive'
      && event.depth === 2
      && event.stack?.filter(item => item === 'GET /api/telemetry-recursive').length === 2,
    )).toBe(true)
  })

  it('hits the echo endpoint directly through Nitro', async () => {
    const result = await $fetch<{ value: string, call: number }>('/api/echo', {
      query: { v: 'direct' },
    })
    expect(result.value).toBe('direct')
    expect(result.call).toBeGreaterThan(0)
  })
})
