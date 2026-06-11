import { fileURLToPath } from 'node:url'
import { $fetch, setup } from '@nuxt/test-utils/e2e'
import { describe, expect, it } from 'vitest'

// The dev worker endpoint registers ONLY in dev (module.ts gates on
// nuxt.options.dev), so this boots the fixture with `dev: true`. It proves the
// handler actually builds and registers under real nitropack v2 — i.e. that its
// import wiring (defineEventHandler/getQuery from `h3`, useNitroApp/
// useRuntimeConfig from `nitropack/runtime`) resolves. The happy-dom unit
// project can't catch that: it stubs `nitropack/runtime`.
describe('dev worker endpoint', async () => {
  await setup({
    rootDir: fileURLToPath(new URL('./fixtures/nuxt-demo', import.meta.url)),
    server: true,
    dev: true,
    browser: false,
  })

  it('registers POST /__cf-jobs/work and responds gracefully without a D1 binding', async () => {
    const body = await $fetch<{ processed: number, byQueue: Record<string, number>, remaining: number, error?: string }>(
      '/__cf-jobs/work',
      { method: 'POST' },
    )
    // The demo fixture has no D1 binding, so the worker has nowhere to read jobs
    // from and returns a graceful result — NOT a 404 (route never registered) or
    // 500 (handler failed to load), which is what a broken import would produce.
    expect(body.processed).toBe(0)
    expect(body.error).toBe('no-d1-binding')
  })
})
