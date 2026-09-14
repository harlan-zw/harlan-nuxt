import type { CheckReport } from '../src/runtime/server'
import { unlink, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { $fetch, setup } from '@nuxt/test-utils/e2e'
import { describe, expect, it } from 'vitest'

describe('check discovery during development', async () => {
  await setup({ rootDir: fileURLToPath(new URL('./fixtures/basic', import.meta.url)), dev: true, browser: false })

  it('discovers added files and removes deleted checks', async () => {
    const file = fileURLToPath(new URL('./fixtures/basic/server/checks/watch.ts', import.meta.url))
    const ids = async () => (await $fetch<CheckReport>('/api/checks')).results.map(result => result.id)
    await ids()
    await writeFile(file, `import { defineCheck } from '@harlan-zw/nuxt-checkin/server'
export default defineCheck({ id: 'watch.added', run: () => ({ _tag: 'Pass', evidence: {} }) })
`)
    try {
      await expect.poll(ids, { timeout: 20_000 }).toContain('watch.added')
    }
    finally {
      await unlink(file)
    }
    await expect.poll(ids, { timeout: 20_000 }).not.toContain('watch.added')
  }, 45_000)
})
