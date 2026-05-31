import { fileURLToPath } from 'node:url'
import { $fetch, setup } from '@nuxt/test-utils/e2e'
import { describe, expect, it } from 'vitest'

// Boots the `nuxt-demo` fixture as a real Nuxt server and drives the module's
// generated registry through the consumer-side runtime over HTTP. Proves the
// `#cf-jobs/app` + `#cf-jobs/server` wiring works end-to-end under nitropack v2,
// which the happy-dom unit project (with its `nitropack/runtime` stub) cannot.
describe('nitro queue runtime', async () => {
  await setup({
    rootDir: fileURLToPath(new URL('./fixtures/nuxt-demo', import.meta.url)),
    server: true,
    browser: false,
  })

  it('dispatches a registered job through the real Nuxt server', async () => {
    const body = await $fetch('/api/run-job')

    expect(body.success).toBe(true)
    expect(body.registeredJobs).toContain('sync/table')
    expect(body.registeredJobs).toContain('analytics/rollup-rebuild')
  })
})
