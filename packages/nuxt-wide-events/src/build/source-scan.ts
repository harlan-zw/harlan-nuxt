import type { Plugin } from 'vite'
import { normalize, relative } from 'pathe'
import { formatWideEventSourceIssues, transformWideEventSource } from './source-validation'

const SOURCE_PATTERN = /\.[cm]?[jt]sx?$/i

export function createWideEventValidationPlugin(
  rootDir: string,
  fields: ReadonlySet<string>,
): Plugin {
  return {
    name: 'nuxt-wide-events:validate-fields',
    enforce: 'pre',
    transform(source, id) {
      const file = sourceFile(id)
      if (!file)
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
