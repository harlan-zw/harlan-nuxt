import type { CheckReport } from '../src/runtime/server'
import { cp, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { $fetch, setup } from '@nuxt/test-utils/e2e'
import { afterAll, describe, expect, it } from 'vitest'

describe('check discovery during development', async () => {
  const source = fileURLToPath(new URL('./fixtures/basic', import.meta.url))
  const rootDir = await mkdtemp(fileURLToPath(new URL('./fixtures/.dev-', import.meta.url)))
  // Register first so Vitest stops the server before removing its private fixture.
  afterAll(() => rm(rootDir, { recursive: true, force: true }))
  await cp(source, rootDir, {
    recursive: true,
    filter: path => !['node_modules', '.nuxt', '.output'].includes(basename(path)),
  })
  await symlink(join(source, 'node_modules'), join(rootDir, 'node_modules'), 'dir')
  await setup({ rootDir, dev: true, browser: false })

  it('discovers added files and removes deleted checks', async () => {
    const file = join(rootDir, 'server/checks/watch.ts')
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
