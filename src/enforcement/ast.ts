import { walk } from 'oxc-walker'
import { directoryPatternToRegExp } from './options'

export interface RpcOperationCall {
  /** `defineNuxtRpcQuery` | `defineNuxtRpcMutation` | `defineNuxtQueryGroup` */
  calleeName: string
  /** First argument node — the operation object literal, when present. */
  argument: any | null
}

const RPC_DEFINE_NAMES = new Set([
  'defineNuxtRpcQuery',
  'defineNuxtRpcMutation',
  'defineNuxtQueryGroup',
])

/** Walk once and yield every `defineNuxtRpc*` / `defineNuxtQueryGroup` call. */
export function findRpcOperationCalls(ast: any): RpcOperationCall[] {
  const calls: RpcOperationCall[] = []
  walk(ast.program, {
    enter(node: any) {
      if (node.type !== 'CallExpression')
        return
      const name = getCalleeName(node.callee)
      if (!name || !RPC_DEFINE_NAMES.has(name))
        return
      calls.push({ calleeName: name, argument: node.arguments?.[0] ?? null })
    },
  })
  return calls
}

/** True iff the file contains any string/template literal hitting an api prefix. */
export function hasApiLiteral(ast: any, apiPrefixes: string[]): boolean {
  let found = false
  walk(ast.program, {
    enter(node: any) {
      if (found)
        return
      if (isApiLiteralNode(node, apiPrefixes))
        found = true
    },
  })
  return found
}

/**
 * True iff the file references zod — either imports `zod` / `zod/v4`, or
 * uses a `z.<member>` expression somewhere in the program. Used to scope the
 * server-route-missing-contract rule to files that actually define schemas.
 */
export function hasZodUsage(ast: any): boolean {
  let found = false
  walk(ast.program, {
    enter(node: any) {
      if (found)
        return
      if (node.type === 'ImportDeclaration') {
        const source = node.source?.value
        if (typeof source === 'string' && (source === 'zod' || source.startsWith('zod/'))) {
          found = true
          return
        }
      }
      if (
        node.type === 'MemberExpression'
        && node.object?.type === 'Identifier'
        && node.object.name === 'z'
      ) {
        found = true
      }
    },
  })
  return found
}

/** True iff any `import ... from '<contract-dir>...'` is present. */
export function hasContractImport(ast: any, contractDirs: string[]): boolean {
  let found = false
  walk(ast.program, {
    enter(node: any) {
      if (found || node.type !== 'ImportDeclaration')
        return
      const sourceValue = node.source?.value
      if (typeof sourceValue === 'string' && isContractImport(sourceValue, contractDirs))
        found = true
    },
  })
  return found
}

export function getObjectProperties(node: any): Map<string, any> {
  const props = new Map<string, any>()
  for (const prop of node?.properties ?? []) {
    if (prop.type !== 'Property')
      continue
    const name = getPropertyName(prop.key)
    if (name)
      props.set(name, prop)
  }
  return props
}

export function getLiteralString(node: any): string | null {
  return node?.type === 'Literal' && typeof node.value === 'string'
    ? node.value
    : null
}

function getCalleeName(callee: any): string | null {
  if (callee?.type === 'Identifier')
    return callee.name
  if (callee?.type === 'MemberExpression' && callee.property?.type === 'Identifier')
    return callee.property.name
  return null
}

function getPropertyName(node: any): string | null {
  if (node?.type === 'Identifier')
    return node.name
  if (node?.type === 'Literal' && typeof node.value === 'string')
    return node.value
  return null
}

function isApiLiteralNode(node: any, apiPrefixes: string[]): boolean {
  if (node.type === 'Literal' && typeof node.value === 'string')
    return apiPrefixes.some(prefix => matchesPrefix(node.value, prefix))

  if (node.type === 'TemplateElement') {
    const value = node.value?.cooked ?? node.value?.raw
    return typeof value === 'string' && apiPrefixes.some(prefix => matchesPrefix(value, prefix))
  }

  return false
}

function matchesPrefix(value: string, prefix: string): boolean {
  return value === prefix || value.startsWith(`${prefix}/`) || value.startsWith(`${prefix}?`)
}

function isContractImport(importSource: string, contractDirs: string[]): boolean {
  return (
    /shared\/contracts(?:\/|$)/.test(importSource)
    || contractDirs.some(dir => directoryPatternToRegExp(dir).test(importSource))
  )
}
