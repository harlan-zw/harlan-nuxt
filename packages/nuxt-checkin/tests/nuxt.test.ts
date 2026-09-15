import type { CheckReport } from '../src/runtime/server'
import { fileURLToPath } from 'node:url'
import { $fetch, setup } from '@nuxt/test-utils/e2e'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli/run'

describe('built Nuxt check route', async () => {
  await setup({ rootDir: fileURLToPath(new URL('./fixtures/basic', import.meta.url)), dev: false, browser: false })

  it('runs site and layer checks from the virtual module', async () => {
    const report = await $fetch<CheckReport>('/api/checks')
    expect(report).toMatchObject({ schemaVersion: 1, identity: { site: 'fixture', environment: 'test', deployment: 'fixture-v1' }, severity: 'warn', coverage: 'incomplete' })
    expect(report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'catalog.freshness', result: { _tag: 'Warn', reason: 'Catalog is stale.', evidence: { hours: 6 } } }),
      expect.objectContaining({ id: 'd1.read', result: { _tag: 'Pass', evidence: { binding: 'DB', readable: true } } }),
      expect.objectContaining({ id: 'queue.indexing', result: expect.objectContaining({ _tag: 'Pass' }) }),
      expect.objectContaining({ id: 'sentry.site', result: { _tag: 'Unavailable', reason: 'Sentry read credential is unavailable.' } }),
      expect.objectContaining({ id: 'content.ready', result: { _tag: 'Pass', evidence: { pages: 3 } } }),
    ]))
  })
  it('carries configured prompt items through the generated module artifact into CLI JSON', async () => {
    let output = ''
    await runCli([], {
      cwd: fileURLToPath(new URL('./fixtures/basic', import.meta.url)),
      env: {},
      stdout: (text) => { output = text },
    })
    expect(JSON.parse(output).prompts).toEqual([
      { id: 'fixture.analysis', prompt: 'Explain the collected activity changes.' },
    ])
  })
})
