import { parseModule } from 'magicast'

// Minimal structural typing of the Babel AST nodes we touch. Keeping this local
// avoids coupling build-time metadata extraction to @babel/types.
export interface StaticAstNode {
  type: string
  [key: string]: unknown
}

export function findStaticObjectCall(source: string, calleeNames: readonly string[]): StaticAstNode | undefined {
  return firstObjectArg(findCallExpression(parseStaticModule(source), calleeNames))
}

function parseStaticModule(source: string): StaticAstNode | undefined {
  try {
    const ast = parseModule(source).$ast
    return isStaticAstNode(ast) ? ast : undefined
  }
  catch {
    return undefined
  }
}

function isStaticAstNode(value: unknown): value is StaticAstNode {
  return typeof value === 'object' && value !== null && typeof (value as StaticAstNode).type === 'string'
}

function findCallExpression(node: unknown, calleeNames: readonly string[]): StaticAstNode | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findCallExpression(child, calleeNames)
      if (found)
        return found
    }
    return undefined
  }

  if (!isStaticAstNode(node))
    return undefined

  if (node.type === 'CallExpression') {
    const callee = node.callee
    if (isStaticAstNode(callee) && callee.type === 'Identifier' && typeof callee.name === 'string' && calleeNames.includes(callee.name))
      return node
  }

  for (const key in node) {
    if (key === 'type')
      continue
    const found = findCallExpression(node[key], calleeNames)
    if (found)
      return found
  }

  return undefined
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
    && prop.type === 'ObjectProperty'
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
  if (node.type === 'StringLiteral' && typeof node.value === 'string')
    return node.value
  if (node.type === 'TemplateLiteral' && Array.isArray(node.expressions) && node.expressions.length === 0) {
    const quasi = Array.isArray(node.quasis) ? node.quasis[0] : undefined
    return templateElementCooked(quasi)
  }
}

export function numberLiteralValue(node: unknown): number | undefined {
  return isStaticAstNode(node) && node.type === 'NumericLiteral' && typeof node.value === 'number'
    ? node.value
    : undefined
}

export function booleanLiteralValue(node: unknown): boolean | undefined {
  return isStaticAstNode(node) && node.type === 'BooleanLiteral' && typeof node.value === 'boolean'
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
  if (key.type === 'StringLiteral' && typeof key.value === 'string')
    return key.value
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
