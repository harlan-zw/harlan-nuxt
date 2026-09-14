import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, resolve } from 'pathe'
import { rollup } from 'rollup'
import ts from 'typescript'

/** Compile only the selected execution context. Nuxt and Worker aliases cannot cross this boundary. */
export async function bundleChecks(source: string, destination: string): Promise<void> {
  const entry = '\0checkin-entry'
  const bundle = await rollup({
    input: entry,
    plugins: [{
      name: 'checkin-node',
      resolveId(id, importer) {
        if (id === entry)
          return id
        if (id.startsWith('#') || id.startsWith('~/') || id.startsWith('@/'))
          throw new Error(`Node check cannot import a Nuxt alias: ${id}`)
        if (!id.startsWith('.') && !id.startsWith('/'))
          return { id, external: true }
        const path = id.startsWith('/') ? id : resolve(dirname(importer!), id)
        const candidates = extname(path) ? [path] : [path, `${path}.ts`, `${path}.mts`, `${path}.js`, `${path}.mjs`, `${path}/index.ts`, `${path}/index.js`]
        const resolved = candidates.find(file => existsSync(file) && extname(file))
        if (!resolved)
          throw new Error(`Check import is unavailable: ${id}`)
        return resolved
      },
      async load(id) {
        return id === entry ? source : readFile(id, 'utf8')
      },
      transform(code, id) {
        if (/\.[mc]?tsx?$/.test(id))
          return ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext }, fileName: id }).outputText
      },
    }],
    onwarn(warning, warn) {
      if (warning.code === 'UNRESOLVED_IMPORT')
        throw new Error(warning.message)
      warn(warning)
    },
  })
  try {
    await bundle.write({ file: destination, format: 'esm' })
  }
  finally {
    await bundle.close()
  }
}
