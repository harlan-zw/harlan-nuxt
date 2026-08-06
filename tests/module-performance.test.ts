import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadNuxt } from '@nuxt/kit'
import { describe, expect, it } from 'vitest'

const rootDir = resolve(__dirname, 'fixtures/broadcast-playground')
const minimalRootDir = resolve(__dirname, 'fixtures/minimal')
const distModulePath = resolve(__dirname, '../dist/module.mjs')
const packagePath = resolve(__dirname, '../package.json')

describe('module entry performance', () => {
  it('marks package modules as tree shakeable', () => {
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as { sideEffects?: boolean }

    expect(packageJson.sideEffects).toBe(false)
  })

  it('keeps runtime implementation modules out of the built Nuxt module entry', () => {
    if (!existsSync(distModulePath))
      return

    const bundle = readFileSync(distModulePath, 'utf8')

    expect(bundle).not.toMatch(/runtime\/server\/app\.js/)
    expect(bundle).not.toMatch(/runtime\/shared\/broadcast\.js/)
  })

  it('avoids a global runtime config plugin and lazily loads endpoint handlers', async () => {
    const nuxt = await loadNuxt({ cwd: rootDir, dev: true })

    try {
      const plugins = nuxt.options.nitro.plugins ?? []
      expect(plugins).not.toContainEqual(expect.stringContaining('provide-runtime-config'))

      const cfJobsHandlers = nuxt.options.serverHandlers.filter(handler =>
        handler.route === '/__cf-jobs/ws' || handler.route === '/__cf-jobs/work',
      )
      expect(cfJobsHandlers).toHaveLength(2)
      expect(cfJobsHandlers).toEqual(expect.arrayContaining([
        expect.objectContaining({ route: '/__cf-jobs/ws', lazy: true }),
        expect.objectContaining({ route: '/__cf-jobs/work', lazy: true }),
      ]))
    }
    finally {
      await nuxt.close()
    }
  })

  it('adds no dev runtime entries without queues while retaining composable auto imports', async () => {
    const nuxt = await loadNuxt({ cwd: minimalRootDir, dev: true })

    try {
      const importDirs: string[] = []
      await nuxt.callHook('imports:dirs', importDirs)

      expect(nuxt.options.nitro.plugins ?? []).not.toContainEqual(expect.stringContaining('dev-queues'))
      expect(nuxt.options.serverHandlers).not.toContainEqual(expect.objectContaining({ route: '/__cf-jobs/work' }))
      expect(importDirs).toContainEqual(expect.stringContaining('runtime/app/composables'))
    }
    finally {
      await nuxt.close()
    }
  })
})
