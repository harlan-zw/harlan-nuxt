import { parseModule } from 'magicast'

/**
 * Statically-extracted metadata from a job source file's `defineJob({...})` call.
 *
 * Literal-typed fields are populated only when the corresponding property's value
 * is the expected literal kind. Non-literal or computed values are left undefined.
 */
export interface JobStaticMeta {
  /** Only if the `defineJob` arg has a string-literal `queue`. */
  queue?: string
  /** Only if the arg has a string-literal `jobType`. */
  jobType?: string
  /** Only if the arg has a numeric-literal `maxAttempts`. */
  maxAttempts?: number
  /** Only if the arg has a numeric-literal `tries`. */
  tries?: number
  /** Only if the arg has a boolean-literal `unique`. */
  unique?: boolean
  /** Whether the arg object has an `input` key (any value). */
  hasInput: boolean
  /** Whether the arg object has a `uniqueId` key (any value). */
  hasUniqueId: boolean
}

// Minimal structural typing of the Babel AST nodes we touch. We treat nodes
// structurally (by `type`) rather than depending on @babel/types.
interface Node {
  type: string
  [key: string]: unknown
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as Node).type === 'string'
}

function emptyMeta(): JobStaticMeta {
  return { hasInput: false, hasUniqueId: false }
}

/**
 * Depth-first search for the first `CallExpression` whose callee is an
 * Identifier named `defineJob`, anywhere in the AST.
 */
function findDefineJobCall(node: unknown): Node | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findDefineJobCall(child)
      if (found)
        return found
    }
    return undefined
  }

  if (!isNode(node))
    return undefined

  if (node.type === 'CallExpression') {
    const callee = node.callee
    if (isNode(callee) && callee.type === 'Identifier' && callee.name === 'defineJob')
      return node
  }

  for (const key in node) {
    if (key === 'type')
      continue
    const found = findDefineJobCall(node[key])
    if (found)
      return found
  }

  return undefined
}

function propKeyName(prop: Node): string | undefined {
  const key = prop.key
  if (!isNode(key))
    return undefined
  if (key.type === 'Identifier' && typeof key.name === 'string')
    return key.name
  if (key.type === 'StringLiteral' && typeof key.value === 'string')
    return key.value
  return undefined
}

/**
 * Statically extract metadata from a job source file's `defineJob({...})` call.
 *
 * Parsing is tolerant: any parse failure (or absence of a `defineJob` call)
 * yields the all-default shape rather than throwing.
 */
export function extractJobMeta(code: string): JobStaticMeta {
  const meta = emptyMeta()

  let ast: unknown
  try {
    ast = parseModule(code).$ast
  }
  catch {
    return meta
  }

  const call = findDefineJobCall(ast)
  if (!call)
    return meta

  const args = call.arguments
  const arg = Array.isArray(args) ? args[0] : undefined
  if (!isNode(arg) || arg.type !== 'ObjectExpression')
    return meta

  const properties = Array.isArray(arg.properties) ? arg.properties : []
  for (const prop of properties) {
    if (!isNode(prop) || prop.type !== 'ObjectProperty')
      continue
    if (prop.computed === true)
      continue

    const name = propKeyName(prop)
    if (!name)
      continue

    const value = prop.value

    switch (name) {
      case 'queue':
        if (isNode(value) && value.type === 'StringLiteral' && typeof value.value === 'string')
          meta.queue = value.value
        break
      case 'jobType':
        if (isNode(value) && value.type === 'StringLiteral' && typeof value.value === 'string')
          meta.jobType = value.value
        break
      case 'maxAttempts':
        if (isNode(value) && value.type === 'NumericLiteral' && typeof value.value === 'number')
          meta.maxAttempts = value.value
        break
      case 'tries':
        if (isNode(value) && value.type === 'NumericLiteral' && typeof value.value === 'number')
          meta.tries = value.value
        break
      case 'unique':
        if (isNode(value) && value.type === 'BooleanLiteral' && typeof value.value === 'boolean')
          meta.unique = value.value
        break
      case 'input':
        meta.hasInput = true
        break
      case 'uniqueId':
        meta.hasUniqueId = true
        break
    }
  }

  return meta
}
