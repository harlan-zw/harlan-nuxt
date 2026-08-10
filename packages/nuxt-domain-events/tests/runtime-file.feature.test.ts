import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createResolver } from '@nuxt/kit'
import { describe, expect, it } from 'vitest'
import { resolveRuntimeFile } from '../src/build/runtime-file'

describe('published runtime file resolution', () => {
  it('resolves the JavaScript emitted by the package build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuxt-domain-events-dist-'))
    const modulePath = join(root, 'module.mjs')
    const jobPath = join(root, 'runtime/server/jobs/deliver-listener.js')
    await mkdir(join(jobPath, '..'), { recursive: true })
    await Promise.all([
      writeFile(modulePath, ''),
      writeFile(jobPath, 'export default {}'),
    ])

    const resolver = createResolver(pathToFileURL(modulePath))

    await expect(resolveRuntimeFile(resolver, './runtime/server/jobs/deliver-listener')).resolves.toBe(jobPath)
  })

  it('surfaces a missing package runtime file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuxt-domain-events-missing-'))
    const modulePath = join(root, 'module.mjs')
    await writeFile(modulePath, '')

    const resolver = createResolver(pathToFileURL(modulePath))

    await expect(resolveRuntimeFile(resolver, './runtime/server/jobs/deliver-listener')).rejects.toThrow('Unable to resolve runtime file')
  })
})
