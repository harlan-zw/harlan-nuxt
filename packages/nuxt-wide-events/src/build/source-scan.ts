import type { Plugin } from 'vite'
import { normalize, relative, resolve } from 'pathe'
import { formatWideEventSourceIssues, transformWideEventSource } from './source-validation.ts'

const SOURCE_PATTERN = /\.[cm]?[jt]sx?$/i

export function createWideEventValidationPlugin(
  rootDir: string,
  fields: ReadonlySet<string>,
  typesDir?: string,
): Plugin {
  const generatedServerImports = typesDir && resolve(typesDir, 'types/server-imports.mjs')
  return {
    name: 'nuxt-wide-events:validate-fields',
    enforce: 'pre',
    transform(source, id) {
      const file = sourceFile(id)
      if (!file || file === generatedServerImports)
        return null

      const displayFile = normalize(relative(rootDir, file))
      const result = transformWideEventSource(source, displayFile, fields)
      if (result._tag === 'Err')
        throw new Error(`[nuxt-wide-events]\n${formatWideEventSourceIssues(result.issues)}`)
      return result.source === source ? null : { code: result.source, map: null }
    },
  }
}

function sourceFile(id: string): string | undefined {
  if (id.startsWith('\0'))
    return undefined
  const file = normalize(id.split(/[?#]/, 1)[0]!)
  return SOURCE_PATTERN.test(file) ? file : undefined
}
