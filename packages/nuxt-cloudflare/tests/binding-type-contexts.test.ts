import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildNuxt, loadNuxt } from '@nuxt/kit'
import ts from 'typescript'
import { expect, it } from 'vitest'
import cloudflareModule from '../src/module'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

it('types binding responses across native Nuxt contexts while compiling Vue props', async () => {
  const root = await mkdtemp(join(packageRoot, '.binding-types-'))
  await mkdir(join(root, 'server/api'), { recursive: true })
  await mkdir(join(root, 'shared'), { recursive: true })
  await mkdir(join(root, 'app'), { recursive: true })
  await writeFile(join(root, 'nuxt.config.ts'), 'export default {}')
  await writeFile(join(root, 'app/app.vue'), '<script setup lang="ts">defineProps<{ label: string }>()</script><template><p>{{ label }}</p></template>')
  await writeFile(join(root, 'server/api/assets.get.ts'), `import type {H3Event} from 'h3';import {createCloudflareBindings} from '@harlan-zw/nuxt-cloudflare/bindings';export default (event:H3Event)=>createCloudflareBindings().require('ASSETS',event).fetch('https://example.com')`)
  await writeFile(join(root, 'shared/response.ts'), `import type handler from '../server/api/assets.get';export type AssetResponse = Awaited<ReturnType<typeof handler>>`)
  const nuxt = await loadNuxt({ cwd: root, dev: false, overrides: {
    modules: [cloudflareModule],
    compatibilityDate: '2026-10-01',
    devtools: { enabled: false },
    nitro: { preset: 'node-server' },
  } })
  try {
    await buildNuxt(nuxt)
    for (const project of ['shared', 'server', 'app']) {
      const parsed = ts.getParsedCommandLineOfConfigFile(join(root, `.nuxt/tsconfig.${project}.json`), {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')) },
      })!
      const program = ts.createProgram(parsed.fileNames, parsed.options)
      const diagnostics = ts.getPreEmitDiagnostics(program).filter(diagnostic => diagnostic.file?.fileName.startsWith(root))
      expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), project).toEqual([])
    }
  }
  finally {
    await nuxt.close()
    await rm(root, { recursive: true })
  }
}, 60_000)
