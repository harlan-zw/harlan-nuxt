import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadNuxt } from '@nuxt/kit'
import { describe, expect, it } from 'vitest'
import Checkin from '../src/module'
import { runExternalChecks } from '../src/runtime/external'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
describe('execution boundaries', () => {
  it('prepares external checks without executing build or server checks', async () => {
    const root = await mkdtemp(join(packageRoot, '.execution-'))
    const marker = join(root, 'built.txt')
    await mkdir(join(root, 'checks/external'), { recursive: true })
    await mkdir(join(root, 'checks/build'), { recursive: true })
    await mkdir(join(root, 'server/checks'), { recursive: true })
    await writeFile(join(root, 'checks/external/env.ts'), 'import {defineExternalCheck,pass} from \'@harlan-zw/nuxt-checkin/external\';export default defineExternalCheck({id:\'external.env\',run:({env})=>pass({value:env.RUNTIME})})')
    await writeFile(join(root, 'checks/build/ready.ts'), `import {writeFile} from 'node:fs/promises';import {defineCheck,pass} from '@harlan-zw/nuxt-checkin/server';export default defineCheck({id:'build.ready',async run(){await writeFile(${JSON.stringify(marker)},'built');return pass()}})`)
    await writeFile(join(root, 'server/checks/private.ts'), 'import {defineCheck} from \'@harlan-zw/nuxt-checkin/server\';throw new Error(\'Server code entered Node\');export default defineCheck({id:\'server.private\',run:()=>({_tag:\'Pass\',evidence:{}})})')
    const nuxt = await loadNuxt({ cwd: root, dev: false, overrides: { modules: [[Checkin, { external: { required: ['external.env'] } }]] } })
    try {
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      const registry = await import(pathToFileURL(join(root, '.nuxt/checkin/external.mjs')).href)
      const result = await runExternalChecks(registry.default, registry.options, { env: { RUNTIME: 'execution-value' } })
      expect(result.report.results[0]?.result).toEqual({ _tag: 'Pass', evidence: { value: 'execution-value' } })
      await nuxt.callHook('build:before')
      expect(await readFile(marker, 'utf8')).toBe('built')
    }
    finally {
      await nuxt.close()
      await rm(root, { recursive: true })
    }
  }, 30_000)
})
