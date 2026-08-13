import { parseSync } from 'vite'

const API_NAME = 'addWideEventFields'
const PACKAGE_SERVER_EXPORT = '@harlan-zw/nuxt-wide-events/server'
const NUXT_SERVER_IMPORTS = new Set(['#imports', '#server-imports'])

interface AstNode {
  type: string
  start?: number
  [key: string]: any
}

interface SourceIssueBase {
  file: string
  line: number
}

export type WideEventSourceIssue
  = | SourceIssueBase & { _tag: 'ComputedField' }
    | SourceIssueBase & { _tag: 'DuplicateField', field: string }
    | SourceIssueBase & { _tag: 'DynamicFields' }
    | SourceIssueBase & { _tag: 'ParseFailure', message: string }
    | SourceIssueBase & { _tag: 'SpreadFields' }
    | SourceIssueBase & { _tag: 'UnknownField', field: string }

export type ValidateWideEventSourceResult
  = | { _tag: 'Ok' }
    | { _tag: 'Err', issues: WideEventSourceIssue[] }

export function validateWideEventSource(
  source: string,
  file: string,
  allowedFields: ReadonlySet<string>,
): ValidateWideEventSourceResult {
  if (!source.includes(API_NAME))
    return { _tag: 'Ok' }

  const parsed = parseSync(file, source, {
    lang: languageFor(file),
    sourceType: 'module',
  })
  if (parsed.errors.length > 0) {
    return {
      _tag: 'Err',
      issues: parsed.errors.map(error => ({
        _tag: 'ParseFailure',
        file,
        line: 1,
        message: error.message,
      })),
    }
  }

  const issues: WideEventSourceIssue[] = []
  const rootScope = createScope(undefined)
  collectStatementBindings(parsed.program.body ?? [], rootScope)
  visitNode(parsed.program, rootScope, source, file, allowedFields, issues)

  return issues.length > 0 ? { _tag: 'Err', issues } : { _tag: 'Ok' }
}

export function formatWideEventSourceIssues(issues: readonly WideEventSourceIssue[]): string {
  return issues.map((issue) => {
    const location = `${issue.file}:${issue.line}`
    if (issue._tag === 'UnknownField')
      return `${location} Field "${issue.field}" is not configured in wideEvents.fields.`
    if (issue._tag === 'DynamicFields')
      return `${location} addWideEventFields() requires an object literal.`
    if (issue._tag === 'SpreadFields')
      return `${location} Wide Event fields cannot use object spreads.`
    if (issue._tag === 'ComputedField')
      return `${location} Wide Event field names must be literals.`
    if (issue._tag === 'DuplicateField')
      return `${location} Field "${issue.field}" appears more than once.`
    return `${location} ${issue.message}`
  }).join('\n')
}

type Binding = 'Api' | 'Local'

interface Scope {
  bindings: Map<string, Binding>
  parent?: Scope
}

function createScope(parent: Scope | undefined): Scope {
  return parent ? { bindings: new Map(), parent } : { bindings: new Map() }
}

function collectStatementBindings(statements: readonly AstNode[], scope: Scope): void {
  for (const candidate of statements) {
    const statement = candidate.type === 'ExportNamedDeclaration' || candidate.type === 'ExportDefaultDeclaration'
      ? candidate.declaration
      : candidate
    if (!statement)
      continue
    if (statement.type === 'ImportDeclaration') {
      collectImportBindings(statement, scope)
      continue
    }
    if (statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations ?? [])
        collectPatternBindings(declaration.id, scope)
      continue
    }
    if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration')
      bindName(statement.id?.name, 'Local', scope)
  }
}

function collectImportBindings(node: AstNode, scope: Scope): void {
  const source = node.source?.value
  const serverImport = source === PACKAGE_SERVER_EXPORT || NUXT_SERVER_IMPORTS.has(source)
  for (const specifier of node.specifiers ?? []) {
    const local = specifier.local?.name
    if (!local)
      continue
    const imported = propertyName(specifier.imported)
    bindName(local, serverImport && imported === API_NAME ? 'Api' : 'Local', scope)
  }
}

function collectPatternBindings(node: AstNode | undefined, scope: Scope): void {
  const pattern = unwrap(node)
  if (!pattern)
    return
  if (pattern.type === 'Identifier') {
    bindName(pattern.name, 'Local', scope)
    return
  }
  if (pattern.type === 'RestElement') {
    collectPatternBindings(pattern.argument, scope)
    return
  }
  if (pattern.type === 'AssignmentPattern') {
    collectPatternBindings(pattern.left, scope)
    return
  }
  if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties ?? [])
      collectPatternBindings(property.type === 'RestElement' ? property.argument : property.value, scope)
    return
  }
  if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements ?? [])
      collectPatternBindings(element, scope)
  }
}

function bindName(name: unknown, binding: Binding, scope: Scope): void {
  if (typeof name === 'string')
    scope.bindings.set(name, binding)
}

function resolveBinding(scope: Scope, name: string): Binding | undefined {
  for (let current: Scope | undefined = scope; current; current = current.parent) {
    const binding = current.bindings.get(name)
    if (binding)
      return binding
  }
}

function visitNode(
  node: AstNode | undefined,
  scope: Scope,
  source: string,
  file: string,
  allowedFields: ReadonlySet<string>,
  issues: WideEventSourceIssue[],
): void {
  if (!node)
    return

  if (node.type === 'Program') {
    visitChildren(node.body, scope, source, file, allowedFields, issues)
    return
  }
  if (node.type === 'BlockStatement') {
    const blockScope = createScope(scope)
    collectStatementBindings(node.body ?? [], blockScope)
    visitChildren(node.body, blockScope, source, file, allowedFields, issues)
    return
  }
  if (isFunction(node)) {
    const functionScope = createScope(scope)
    bindName(node.id?.name, 'Local', functionScope)
    for (const parameter of node.params ?? [])
      collectPatternBindings(parameter, functionScope)
    visitNode(node.body, functionScope, source, file, allowedFields, issues)
    return
  }
  if (node.type === 'CatchClause') {
    const catchScope = createScope(scope)
    collectPatternBindings(node.param, catchScope)
    visitNode(node.body, catchScope, source, file, allowedFields, issues)
    return
  }
  if (node.type === 'CallExpression') {
    const callee = unwrap(node.callee)
    if (callee?.type === 'Identifier' && isApiBinding(callee.name, scope))
      validateFieldsArgument(node.arguments?.[1], source, file, allowedFields, issues)
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'start' || key === 'end')
      continue
    visitUnknown(value, scope, source, file, allowedFields, issues)
  }
}

function visitChildren(
  nodes: readonly AstNode[] | undefined,
  scope: Scope,
  source: string,
  file: string,
  allowedFields: ReadonlySet<string>,
  issues: WideEventSourceIssue[],
): void {
  for (const node of nodes ?? [])
    visitNode(node, scope, source, file, allowedFields, issues)
}

function visitUnknown(
  value: unknown,
  scope: Scope,
  source: string,
  file: string,
  allowedFields: ReadonlySet<string>,
  issues: WideEventSourceIssue[],
): void {
  if (Array.isArray(value)) {
    for (const item of value)
      visitUnknown(item, scope, source, file, allowedFields, issues)
    return
  }
  if (value && typeof value === 'object' && 'type' in value)
    visitNode(value as AstNode, scope, source, file, allowedFields, issues)
}

function isApiBinding(name: unknown, scope: Scope): boolean {
  if (typeof name !== 'string')
    return false
  const binding = resolveBinding(scope, name)
  return binding === 'Api' || (binding === undefined && name === API_NAME)
}

function isFunction(node: AstNode): boolean {
  return node.type === 'FunctionDeclaration'
    || node.type === 'FunctionExpression'
    || node.type === 'ArrowFunctionExpression'
}

function validateFieldsArgument(
  input: AstNode | undefined,
  source: string,
  file: string,
  allowedFields: ReadonlySet<string>,
  issues: WideEventSourceIssue[],
): void {
  const node = unwrap(input)
  if (node?.type !== 'ObjectExpression') {
    issues.push({ _tag: 'DynamicFields', file, line: lineAt(source, node?.start) })
    return
  }

  const seen = new Set<string>()
  for (const candidate of node.properties ?? []) {
    const property = unwrap(candidate)
    const line = lineAt(source, property?.start)
    if (property?.type === 'SpreadElement') {
      issues.push({ _tag: 'SpreadFields', file, line })
      continue
    }
    if (property?.type !== 'Property' || property.computed === true) {
      issues.push({ _tag: 'ComputedField', file, line })
      continue
    }
    const field = propertyName(property.key)
    if (field === undefined) {
      issues.push({ _tag: 'ComputedField', file, line })
      continue
    }
    if (seen.has(field)) {
      issues.push({ _tag: 'DuplicateField', field, file, line })
      continue
    }
    seen.add(field)
    if (!allowedFields.has(field))
      issues.push({ _tag: 'UnknownField', field, file, line })
  }
}

function unwrap(input: AstNode | undefined): AstNode | undefined {
  if (!input)
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

function propertyName(input: AstNode | undefined): string | undefined {
  const node = unwrap(input)
  if (node?.type === 'Identifier' && typeof node.name === 'string')
    return node.name
  if (node?.type === 'Literal' && typeof node.value === 'string')
    return node.value
}

function languageFor(file: string): 'js' | 'jsx' | 'ts' | 'tsx' {
  if (/\.tsx$/i.test(file))
    return 'tsx'
  if (/\.jsx$/i.test(file))
    return 'jsx'
  if (/\.[cm]?js$/i.test(file))
    return 'js'
  return 'ts'
}

function lineAt(source: string, offset = 0): number {
  let line = 1
  for (let index = 0; index < offset; index++) {
    if (source.charCodeAt(index) === 10)
      line++
  }
  return line
}
