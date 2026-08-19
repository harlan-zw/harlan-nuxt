import { parseSync, Visitor } from 'vite'

// Keep parser-specific AST types behind this build-time module.
export interface StaticAstNode {
  type: string
  [key: string]: unknown
}

export function findStaticObjectCall(source: string, calleeNames: readonly string[], filename = 'source.ts'): StaticAstNode | undefined {
  const root = parseStaticModule(source, filename)
  if (!root)
    return undefined

  let call: StaticAstNode | undefined
  new Visitor({
    CallExpression(node) {
      if (call)
        return
      const callee = unwrap(node.callee)
      if (callee?.type === 'Identifier' && typeof callee.name === 'string' && calleeNames.includes(callee.name))
        call = node as unknown as StaticAstNode
    },
  }).visit(root as unknown as Parameters<Visitor['visit']>[0])
  return firstObjectArg(call)
}

function parseStaticModule(source: string, filename: string): StaticAstNode | undefined {
  try {
    const result = parseSync(filename, source, { sourceType: 'module' })
    return result.errors.length === 0 && isStaticAstNode(result.program)
      ? result.program as unknown as StaticAstNode
      : undefined
  }
  catch {
    return undefined
  }
}

function isStaticAstNode(value: unknown): value is StaticAstNode {
  return typeof value === 'object' && value !== null && typeof (value as StaticAstNode).type === 'string'
}

function firstObjectArg(call: StaticAstNode | undefined): StaticAstNode | undefined {
  const args = Array.isArray(call?.arguments) ? call.arguments : []
  const arg = args[0]
  return isObjectExpression(arg) ? arg : undefined
}

function getObjectProperty(obj: StaticAstNode | undefined, name: string): StaticAstNode | undefined {
  if (!isObjectExpression(obj) || !Array.isArray(obj.properties))
    return undefined
  return obj.properties.find((prop): prop is StaticAstNode => (
    isStaticAstNode(prop)
    && prop.type === 'Property'
    && prop.computed !== true
    && propKeyName(prop) === name
  ))
}

export function getStaticObjectValue(obj: StaticAstNode | undefined, name: string): StaticAstNode | undefined {
  const value = getObjectProperty(obj, name)?.value
  return isStaticAstNode(value) ? value : undefined
}

export function hasStaticObjectProperty(obj: StaticAstNode | undefined, name: string): boolean {
  return !!getObjectProperty(obj, name)
}

export function stringLiteralValue(node: unknown): string | undefined {
  if (!isStaticAstNode(node))
    return undefined
  if (node.type === 'Literal' && typeof node.value === 'string')
    return node.value
  if (node.type === 'TemplateLiteral' && Array.isArray(node.expressions) && node.expressions.length === 0) {
    const quasi = Array.isArray(node.quasis) ? node.quasis[0] : undefined
    return templateElementCooked(quasi)
  }
}

export function numberLiteralValue(node: unknown): number | undefined {
  return isStaticAstNode(node) && node.type === 'Literal' && typeof node.value === 'number'
    ? node.value
    : undefined
}

export function booleanLiteralValue(node: unknown): boolean | undefined {
  return isStaticAstNode(node) && node.type === 'Literal' && typeof node.value === 'boolean'
    ? node.value
    : undefined
}

export function stringArrayValue(node: unknown): string[] {
  if (!isStaticAstNode(node) || node.type !== 'ArrayExpression' || !Array.isArray(node.elements))
    return []
  return node.elements.flatMap((element) => {
    const value = stringLiteralValue(element)
    return value === undefined ? [] : [value]
  })
}

function isObjectExpression(node: unknown): node is StaticAstNode {
  return isStaticAstNode(node) && node.type === 'ObjectExpression'
}

function propKeyName(prop: StaticAstNode): string | undefined {
  const key = prop.key
  if (!isStaticAstNode(key))
    return undefined
  if (key.type === 'Identifier' && typeof key.name === 'string')
    return key.name
  if (key.type === 'Literal' && typeof key.value === 'string')
    return key.value
}

function unwrap(input: unknown): StaticAstNode | undefined {
  if (!isStaticAstNode(input))
    return undefined
  if (
    input.type === 'TSAsExpression'
    || input.type === 'TSSatisfiesExpression'
    || input.type === 'TSNonNullExpression'
    || input.type === 'ChainExpression'
  ) {
    return unwrap(input.expression)
  }
  return input
}

function templateElementCooked(node: unknown): string | undefined {
  if (!isStaticAstNode(node))
    return undefined
  const value = node.value
  if (!value || typeof value !== 'object')
    return undefined
  const cooked = (value as { cooked?: unknown }).cooked
  return typeof cooked === 'string' ? cooked : undefined
}
