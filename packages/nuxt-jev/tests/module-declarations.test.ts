import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('emits portable declarations for the Nuxt module entry point', () => {
  const program = ts.createProgram({
    rootNames: [fileURLToPath(new URL('../src/module.ts', import.meta.url))],
    options: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
      declaration: true,
      emitDeclarationOnly: true,
    },
  })

  // Exercise declaration emission without writing generated files into source.
  const result = program.emit(undefined, () => {})
  expect(result.diagnostics.map(diagnostic => ({
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  }))).toEqual([])
  expect(result.emitSkipped).toBe(false)
})
