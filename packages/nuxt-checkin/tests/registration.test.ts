import { fileURLToPath } from 'node:url'
import { loadNuxt } from '@nuxt/kit'
import { describe, expect, it } from 'vitest'

const rootDir = fileURLToPath(new URL('./fixtures/basic', import.meta.url))

describe('module registration errors', () => {
  it.each([
    { id: 'catalog.freshness', options: {}, error: 'Duplicate check ID' },
    { id: 'other', options: { load: () => 'computed' }, error: 'JSON values' },
  ])('rejects $error before server execution', async ({ id, options, error }) => {
    const nuxt = await loadNuxt({ cwd: rootDir, dev: false })
    try {
      nuxt.hook('checkin:register', registry => registry.add({ id, handler: '/not-executed.ts', options }))
      await expect(nuxt.callHook('build:before')).rejects.toThrow(error)
    }
    finally {
      await nuxt.close()
    }
  }, 30_000)
})
