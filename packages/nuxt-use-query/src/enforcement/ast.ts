import { Visitor } from 'vite'
import { directoryPatternToRegExp } from './options'

export interface RpcOperationCall {
  /** `defineNuxtRpcQuery` | `defineNuxtRpcMutation` | `defineNuxtQueryGroup` */
  calleeName: string
  /** First argument node — the operation object literal, when present. */
  argument: any | null
}

export interface SourceAstAnalysis {
  hasApiLiteral: boolean
  hasContractImport: boolean
  hasZodUsage: boolean
  rpcOperationCalls: RpcOperationCall[]
}

/** Per-file facts the analyzer needs before it walks the AST. */
export interface SourceAstContext {
  /** Query files may define operations through their own wrapper factory. */
  isQueryFile: boolean
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

/**
 * Compile option-dependent matchers once per scan, then collect every fact the
 * rules need in one AST traversal per file.
 */
export function createSourceAstAnalyzer(apiPrefixes: string[], contractDirs: string[]): (ast: any, context: SourceAstContext) => SourceAstAnalysis {
  const normalizedApiPrefixes = apiPrefixes.map(normalizeApiPrefix)
  const contractPatterns = contractDirs.map(directoryPatternToRegExp)

  return (ast: any, context: SourceAstContext): SourceAstAnalysis => {
    const rpcOperationCalls: RpcOperationCall[] = []
    const zodNamespaces = new Set<string>()
    const zodFactories = new Set<string>()
    const zodMemberCallNamespaces = new Set<string>()
    const zodFactoryCalls = new Set<string>()
    let hasApiLiteral = false
    let hasContractImport = false

    // Module bindings resolve before the walk, because a call can appear above
    // the import that names its factory. Import and export declarations are
    // top-level only, so this pass stays cheap.
    const rpcFactoryNames = collectRpcFactoryNames(ast.program)
    for (const node of ast.program?.body ?? []) {
      if (node?.type !== 'ImportDeclaration')
        continue
      const source = node.source?.value
      if (typeof source !== 'string')
        continue
      if (!hasContractImport && contractPatterns.some(pattern => pattern.test(source)))
        hasContractImport = true
      if (source === 'zod' || source.startsWith('zod/'))
        collectZodImports(node, zodNamespaces, zodFactories)
    }

    new Visitor({
      ImportExpression(node) {
        const source = (node.source as { value?: unknown })?.value
        if (!hasContractImport && typeof source === 'string' && contractPatterns.some(pattern => pattern.test(source)))
          hasContractImport = true
      },
      Literal(node) {
        if (!hasApiLiteral && isApiLiteralNode(node, normalizedApiPrefixes))
          hasApiLiteral = true
      },
      TemplateElement(node) {
        if (!hasApiLiteral && isApiLiteralNode(node, normalizedApiPrefixes))
          hasApiLiteral = true
      },
      CallExpression(node) {
        collectRpcOperationCall(node, rpcOperationCalls, rpcFactoryNames, context)
        if (node.callee?.type === 'MemberExpression' && node.callee.object?.type === 'Identifier') {
          const factory = getPropertyName(node.callee.property)
          if (factory && ZOD_SCHEMA_FACTORY_NAMES.has(factory))
            zodMemberCallNamespaces.add(node.callee.object.name)
        }
        else if (node.callee?.type === 'Identifier') {
          zodFactoryCalls.add(node.callee.name)
        }
      },
    }).visit(ast.program)

    const hasZodUsage = setsIntersect(zodMemberCallNamespaces, zodNamespaces)
      || setsIntersect(zodFactoryCalls, zodFactories)

    return {
      hasApiLiteral,
      hasContractImport,
      hasZodUsage,
      rpcOperationCalls,
    }
  }
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

function isApiLiteralNode(node: any, normalizedApiPrefixes: string[]): boolean {
  if (node.type === 'Literal' && typeof node.value === 'string')
    return normalizedApiPrefixes.some(prefix => matchesNormalizedPrefix(node.value, prefix))

  if (node.type === 'TemplateElement') {
    const value = node.value?.cooked ?? node.value?.raw
    return typeof value === 'string' && normalizedApiPrefixes.some(prefix => matchesNormalizedPrefix(value, prefix))
  }

  return false
}

function matchesNormalizedPrefix(value: string, prefix: string): boolean {
  return value === prefix || value.startsWith(`${prefix}/`) || value.startsWith(`${prefix}?`)
}

function collectRpcOperationCall(
  node: any,
  calls: RpcOperationCall[],
  factoryNames: Map<string, string>,
  context: SourceAstContext,
): void {
  const name = getCalleeName(node.callee)
  if (!name)
    return
  const canonical = factoryNames.get(name)
  if (canonical == null) {
    // A query file may wrap the shipped factories in its own scoped helper
    // (`defineProQuery`, `defineBillingMutation`). The wrapper name cannot be
    // resolved across files, so the operation object itself is the signal.
    if (context.isQueryFile)
      collectWrappedOperationObject(node.arguments?.[0], calls)
    return
  }
  if (canonical === 'defineNuxtQueryGroup') {
    calls.push({ calleeName: canonical, argument: node.arguments?.[1] ?? null })
    collectQueryGroupOperationObjects(node.arguments?.[1], calls)
    return
  }
  calls.push({ calleeName: canonical, argument: node.arguments?.[0] ?? null })
}

/**
 * Map every local name that reaches one of the shipped factories back to its
 * canonical name. Covers `import { defineNuxtRpcQuery as defineProQuery }`,
 * `export { defineNuxtRpcQuery as defineProQuery }`, and
 * `const defineProQuery = defineNuxtRpcQuery`. The canonical names stay
 * mapped to themselves, because Nuxt auto-imports them without any import.
 */
function collectRpcFactoryNames(program: any): Map<string, string> {
  const names = new Map<string, string>()
  for (const name of RPC_DEFINE_NAMES)
    names.set(name, name)

  for (const node of program?.body ?? []) {
    if (node?.type === 'ImportDeclaration' || node?.type === 'ExportNamedDeclaration') {
      for (const specifier of node.specifiers ?? []) {
        const source = getPropertyName(specifier.imported ?? specifier.local)
        const local = getPropertyName(specifier.local ?? specifier.exported)
        const alias = getPropertyName(specifier.exported) ?? local
        if (source == null || !RPC_DEFINE_NAMES.has(source))
          continue
        if (local != null)
          names.set(local, source)
        if (alias != null)
          names.set(alias, source)
      }
    }
    const declaration = node?.type === 'ExportNamedDeclaration' ? node.declaration : node
    if (declaration?.type !== 'VariableDeclaration')
      continue
    for (const declarator of declaration.declarations ?? []) {
      if (declarator.id?.type !== 'Identifier' || declarator.init?.type !== 'Identifier')
        continue
      const source = names.get(declarator.init.name)
      if (source != null)
        names.set(declarator.id.name, source)
    }
  }
  return names
}

/**
 * Read the first argument of an unknown factory call as an operation. An
 * operation always names a `path` plus its cache `key` (query) or its HTTP
 * `method` (mutation), which a route or navigation target does not.
 */
function collectWrappedOperationObject(node: any, calls: RpcOperationCall[]): void {
  if (node?.type !== 'ObjectExpression')
    return
  const props = getObjectProperties(node)
  if (!props.has('path') || (!props.has('key') && !props.has('method')))
    return
  collectOperationObject(node, calls)
}

function collectZodImports(node: any, namespaces: Set<string>, factories: Set<string>): void {
  for (const specifier of node.specifiers ?? []) {
    if (specifier.type === 'ImportNamespaceSpecifier') {
      namespaces.add(specifier.local?.name)
      continue
    }
    if (specifier.type !== 'ImportSpecifier')
      continue
    const imported = getPropertyName(specifier.imported)
    const local = specifier.local?.name
    if (!local)
      continue
    if (imported === 'z')
      namespaces.add(local)
    if (imported && ZOD_SCHEMA_FACTORY_NAMES.has(imported))
      factories.add(local)
  }
}

function setsIntersect(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value))
      return true
  }
  return false
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
