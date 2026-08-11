import { parseSync } from 'oxc-parser'
import { walk } from 'oxc-walker'

const DEFINE_NAMES = new Set(['defineNuxtPlugin', 'definePayloadPlugin'])

function literalName(node: any): string | undefined {
  if (node?.type !== 'ObjectExpression')
    return undefined
  for (const property of node.properties) {
    if (property.type !== 'Property' || property.key?.name !== 'name')
      continue
    const value = property.value
    return value?.type === 'Literal' && typeof value.value === 'string' ? value.value : undefined
  }
  return undefined
}

/**
 * Reads the name from `defineNuxtPlugin({ name })` or `defineNuxtPlugin(fn, { name })`.
 * Nuxt annotates plugins the same way, but only after `app:resolve`, and it does not
 * expose the result, so the name is read straight from source here.
 */
export function extractPluginName(file: string, source: string): string | undefined {
  let name: string | undefined
  try {
    const ast = parseSync(file, source, {
      lang: file.endsWith('.tsx') ? 'tsx' : file.endsWith('.jsx') ? 'jsx' : 'ts',
      sourceType: 'module',
    })
    walk(ast.program, {
      enter(node: any) {
        if (name || node.type !== 'CallExpression' || !DEFINE_NAMES.has(node.callee?.name))
          return
        name = literalName(node.arguments[0]) ?? literalName(node.arguments[1])
      },
    })
  }
  catch {
    // A plugin that does not parse is Nuxt's problem to report; fall back to the file path label.
    return undefined
  }
  return name
}
