import { access, readFile } from 'node:fs/promises'
import { resolve } from 'pathe'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('package contract', () => {
  it('keeps the Nuxt module entry free of the Wrangler CLI', async () => {
    const bundle = await readFile(resolve(root, 'dist/module.mjs'), 'utf8')
    expect(bundle).not.toContain('unstable_readConfig')
    expect(bundle).not.toMatch(/from ['"]wrangler['"]/)
  })

  it('builds every declared public export', async () => {
    const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
      exports: Record<string, { import: string, types: string }>
      sideEffects: boolean
    }
    expect(packageJson.sideEffects).toBe(false)
    await Promise.all(Object.values(packageJson.exports).flatMap(entry => [
      access(resolve(root, entry.import)),
      access(resolve(root, entry.types)),
    ]))
  })

  it('exposes the default Nuxt module from the root declaration', async () => {
    const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
      exports: { '.': { types: string } }
    }
    const declaration = await readFile(resolve(root, packageJson.exports['.'].types), 'utf8')
    expect(declaration).toMatch(/export \{[^}]*default[^}]*\}/)
  })
})
