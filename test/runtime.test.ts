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
  b: { value: string, call: number } | null
  cacheKeys: string[]
  cacheSameInstance: boolean
  hasAutoImports: boolean
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

  it('hits the echo endpoint directly through Nitro', async () => {
    const result = await $fetch<{ value: string, call: number }>('/api/echo', {
      query: { v: 'direct' },
    })
    expect(result.value).toBe('direct')
    expect(result.call).toBeGreaterThan(0)
  })
})
