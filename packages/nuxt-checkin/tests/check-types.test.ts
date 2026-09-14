import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadNuxt, writeTypes } from '@nuxt/kit'
import ts from 'typescript'
import { expect, it } from 'vitest'
import Checkin from '../src/module'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

it('checks TypeScript definitions in Node and legacy Nuxt projects', async () => {
  const root = await mkdtemp(join(packageRoot, '.check-types-'))
  const files = [join(root, 'checks/build/content.ts'), join(root, 'checks/external/provider.mts'), join(root, 'layers/content/checks/external/layer.ts')]
  for (const [index, file] of files.entries()) {
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, `import {defineCheck,unavailable} from '@harlan-zw/nuxt-checkin/server';export default defineCheck({id:'check.${index}',run:()=>unavailable('Missing evidence.',{count:1})})`)
  }
  await writeFile(join(root, 'nuxt.config.ts'), 'export default {}')
  await writeFile(join(root, 'layers/content/nuxt.config.ts'), 'export default {}')
  const nuxt = await loadNuxt({ cwd: root, dev: false, overrides: { modules: [Checkin], extends: ['./layers/content'] } })
  try {
    await writeTypes(nuxt)
    for (const project of ['tsconfig.node.json', 'tsconfig.json']) {
      const path = join(root, '.nuxt', project)
      const parsed = ts.getParsedCommandLineOfConfigFile(path, {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
        },
      })!
      const program = ts.createProgram(parsed.fileNames, parsed.options)
      const diagnostics = ts.getPreEmitDiagnostics(program).filter(diagnostic => diagnostic.code === 2554)
      expect(diagnostics.map(diagnostic => diagnostic.file?.fileName).filter(file => files.includes(file!)).sort()).toEqual([...files].sort())
    }
  }
  finally {
    await nuxt.close()
    await rm(root, { recursive: true })
  }
}, 30_000)
