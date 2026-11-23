import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('typechecks the error overlay against the current DOM API', () => {
  const configPath = fileURLToPath(new URL('../tsconfig.json', import.meta.url))
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  expect(config.error).toBeUndefined()
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath))
  expect(parsed.errors).toEqual([])

  const program = ts.createProgram({
    rootNames: [
      fileURLToPath(new URL('../.nuxt/nuxt.d.ts', import.meta.url)),
      fileURLToPath(new URL('../src/runtime/app/plugins/error-overlay.client.ts', import.meta.url)),
    ],
    options: parsed.options,
  })
  expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ({
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  }))).toEqual([])
})
