import { parseSync } from 'vite'

export interface StaticAstNode {
  type: string
  [key: string]: unknown
}

export function parseStaticModule(source: string, filename: string): StaticAstNode {
  const result = parseSync(filename, source)
  if (result.errors.length > 0) {
    const messages = result.errors.map(error => error.message).join('; ')
    throw new Error(`Cannot parse ${filename}: ${messages}`)
  }
  return result.program as unknown as StaticAstNode
}

export function findObjectCalls(root: StaticAstNode, calleeName: string): StaticAstNode[] {
  const calls: StaticAstNode[] = []
  walk(root, (node) => {
    if (node.type !== 'CallExpression')
      return
    const callee = unwrap(node.callee)
    if (!callee || callee.type !== 'Identifier' || callee.name !== calleeName)
      return
    const args = Array.isArray(node.arguments) ? node.arguments : []
    const first = unwrap(args[0])
    if (first?.type === 'ObjectExpression')
      calls.push(first)
  })
  return calls
}

export function findDefaultExportObjectCall(root: StaticAstNode, calleeName: string): StaticAstNode | undefined {
  const body = Array.isArray(root.body) ? root.body : []
  for (const input of body) {
    const statement = unwrap(input)
    if (!statement || statement.type !== 'ExportDefaultDeclaration')
      continue
    const declaration = unwrap(statement.declaration)
    if (!declaration || declaration.type !== 'CallExpression')
      continue
    const callee = unwrap(declaration.callee)
    if (!callee || callee.type !== 'Identifier' || callee.name !== calleeName)
      continue
    const args = Array.isArray(declaration.arguments) ? declaration.arguments : []
    const first = unwrap(args[0])
    return first?.type === 'ObjectExpression' ? first : undefined
  }
}

export function getObjectValue(object: StaticAstNode, key: string): StaticAstNode | undefined {
  if (object.type !== 'ObjectExpression' || !Array.isArray(object.properties))
    return undefined
  for (const candidate of object.properties) {
    const property = unwrap(candidate)
    if (!property || property.type !== 'Property' || property.computed === true)
      continue
    if (propertyName(property.key) === key)
      return unwrap(property.value)
  }
}

export function getObjectKeys(object: StaticAstNode): string[] {
  if (object.type !== 'ObjectExpression' || !Array.isArray(object.properties))
    return []
  return object.properties.flatMap((candidate) => {
    const property = unwrap(candidate)
    if (!property || property.type !== 'Property' || property.computed === true)
      return []
    const name = propertyName(property.key)
    return name === undefined ? [] : [name]
  })
}

export function assertLiteralObjectMetadata(object: StaticAstNode, label: string): void {
  if (object.type !== 'ObjectExpression' || !Array.isArray(object.properties))
    return
  const seen = new Set<string>()
  for (const candidate of object.properties) {
    const property = unwrap(candidate)
    if (property?.type === 'SpreadElement')
      throw new Error(`${label} cannot use object spreads; routing metadata must be literal`)
    if (property?.type !== 'Property')
      throw new Error(`${label} contains unsupported object metadata`)
    if (property.computed === true)
      throw new Error(`${label} cannot use computed properties; routing metadata must be literal`)
    const name = propertyName(property.key)
    if (name === undefined)
      throw new Error(`${label} property names must be literal`)
    if (seen.has(name))
      throw new Error(`${label} has duplicate property "${name}"`)
    seen.add(name)
  }
}

export function hasObjectKey(object: StaticAstNode, key: string): boolean {
  return getObjectKeys(object).includes(key)
}

export function objectValue(node: unknown): StaticAstNode | undefined {
  const value = unwrap(node)
  return value?.type === 'ObjectExpression' ? value : undefined
}

export function stringValue(node: unknown): string | undefined {
  const value = unwrap(node)
  return value?.type === 'Literal' && typeof value.value === 'string' ? value.value : undefined
}

export function numberValue(node: unknown): number | undefined {
  const value = unwrap(node)
  return value?.type === 'Literal' && typeof value.value === 'number' ? value.value : undefined
}

export function booleanValue(node: unknown): boolean | undefined {
  const value = unwrap(node)
  return value?.type === 'Literal' && typeof value.value === 'boolean' ? value.value : undefined
}

export function numberArrayValue(node: unknown): number[] | undefined {
  const value = unwrap(node)
  if (!value || value.type !== 'ArrayExpression' || !Array.isArray(value.elements))
    return undefined
  const numbers = value.elements.map(numberValue)
  return numbers.every((number): number is number => number !== undefined) ? numbers : undefined
}

function walk(input: unknown, visit: (node: StaticAstNode) => void): void {
  if (Array.isArray(input)) {
    for (const value of input)
      walk(value, visit)
    return
  }
  const node = unwrap(input)
  if (!node)
    return
  visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'start' || key === 'end')
      continue
    walk(value, visit)
  }
}

function unwrap(input: unknown): StaticAstNode | undefined {
  if (!isNode(input))
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

function isNode(input: unknown): input is StaticAstNode {
  return typeof input === 'object' && input !== null && typeof (input as StaticAstNode).type === 'string'
}

function propertyName(input: unknown): string | undefined {
  const node = unwrap(input)
  if (!node)
    return undefined
  if (node.type === 'Identifier' && typeof node.name === 'string')
    return node.name
  if (node.type === 'Literal' && typeof node.value === 'string')
    return node.value
}
