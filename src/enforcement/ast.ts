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

const ZOD_SCHEMA_FACTORY_NAMES = new Set([
  'any',
  'array',
  'bigint',
  'boolean',
  'date',
  'discriminatedUnion',
  'enum',
  'instanceof',
  'intersection',
  'lazy',
  'literal',
  'map',
  'nan',
  'nativeEnum',
  'never',
  'null',
  'nullable',
  'number',
  'object',
  'optional',
  'record',
  'set',
  'string',
  'tuple',
  'undefined',
  'union',
  'unknown',
  'void',
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
      if (name === 'defineNuxtQueryGroup') {
        calls.push({ calleeName: name, argument: node.arguments?.[1] ?? null })
        collectQueryGroupOperationObjects(node.arguments?.[1], calls)
        return
      }
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
  const zodNamespaces = new Set<string>()
  const zodFactories = new Set<string>()

  walk(ast.program, {
    enter(node: any) {
      if (node.type !== 'ImportDeclaration')
        return
      const source = node.source?.value
      if (typeof source !== 'string' || (source !== 'zod' && !source.startsWith('zod/')))
        return
      for (const specifier of node.specifiers ?? []) {
        if (specifier.type === 'ImportNamespaceSpecifier') {
          zodNamespaces.add(specifier.local?.name)
          continue
        }
        if (specifier.type !== 'ImportSpecifier')
          continue
        const imported = getPropertyName(specifier.imported)
        const local = specifier.local?.name
        if (!local)
          continue
        if (imported === 'z')
          zodNamespaces.add(local)
        if (imported && ZOD_SCHEMA_FACTORY_NAMES.has(imported))
          zodFactories.add(local)
      }
    },
  })

  walk(ast.program, {
    enter(node: any) {
      if (found)
        return
      if (
        node.type === 'CallExpression'
        && node.callee?.type === 'MemberExpression'
        && node.callee.object?.type === 'Identifier'
        && zodNamespaces.has(node.callee.object.name)
        && ZOD_SCHEMA_FACTORY_NAMES.has(getPropertyName(node.callee.property) ?? '')
      ) {
        found = true
      }
      if (
        node.type === 'CallExpression'
        && node.callee?.type === 'Identifier'
        && zodFactories.has(node.callee.name)
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
  const normalized = normalizeApiPrefix(prefix)
  return value === normalized || value.startsWith(`${normalized}/`) || value.startsWith(`${normalized}?`)
}

function isContractImport(importSource: string, contractDirs: string[]): boolean {
  return contractDirs.some(dir => directoryPatternToRegExp(dir).test(importSource))
}

function normalizeApiPrefix(prefix: string): string {
  const normalized = prefix.replace(/\/+$/g, '')
  return normalized || '/'
}

function collectQueryGroupOperationObjects(groupArgument: any, calls: RpcOperationCall[]): void {
  if (groupArgument?.type !== 'ObjectExpression')
    return
  for (const prop of groupArgument.properties ?? []) {
    if (prop.type !== 'Property')
      continue
    collectOperationObject(prop.value, calls)
  }
}

function collectOperationObject(node: any, calls: RpcOperationCall[]): void {
  if (node?.type === 'ObjectExpression') {
    const props = getObjectProperties(node)
    if (!props.has('path') && !props.has('key') && !props.has('method'))
      return
    // Factory calls already carry their operation category in the callee. A
    // direct object nested in `defineNuxtQueryGroup` has no call context, but
    // queries require a cache `key` while mutations do not. That remains true
    // for cached POST reads and avoids adding a public `kind` discriminator.
    const isQuery = props.has('key') || !props.has('method')
    calls.push({
      calleeName: isQuery
        ? 'defineNuxtRpcQuery'
        : 'defineNuxtRpcMutation',
      argument: node,
    })
    return
  }
  if (node?.type === 'ArrowFunctionExpression') {
    collectOperationObject(node.body, calls)
    return
  }
  if (node?.type === 'FunctionExpression' || node?.type === 'FunctionDeclaration') {
    for (const statement of node.body?.body ?? []) {
      if (statement.type === 'ReturnStatement')
        collectOperationObject(statement.argument, calls)
    }
  }
}
