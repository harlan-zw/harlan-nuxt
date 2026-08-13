import { parseSync } from 'vite'

const ADD_FIELDS_API_NAME = 'addWideEventFields'
const CREATE_API_NAME = 'createWideEvent'
const PACKAGE_SERVER_EXPORT = '@harlan-zw/nuxt-wide-events/server'
const PACKAGE_STANDALONE_EXPORT = '@harlan-zw/nuxt-wide-events/standalone'
const NUXT_SERVER_IMPORTS = new Set(['#imports', '#server-imports'])

interface AstNode {
  end?: number
  type: string
  start?: number
  [key: string]: any
}

interface SourceInsertion {
  offset: number
  text: string
}

interface SourceIssueBase {
  file: string
  line: number
}

export type WideEventSourceIssue
  = | SourceIssueBase & { _tag: 'ComputedField' }
    | SourceIssueBase & { _tag: 'DuplicateField', field: string }
    | SourceIssueBase & { _tag: 'DynamicFields' }
    | SourceIssueBase & { _tag: 'InvalidApiReference' }
    | SourceIssueBase & { _tag: 'NonDataField' }
    | SourceIssueBase & { _tag: 'ParseFailure', message: string }
    | SourceIssueBase & { _tag: 'SpreadFields' }
    | SourceIssueBase & { _tag: 'UnknownField', field: string }

export type ValidateWideEventSourceResult
  = | { _tag: 'Ok' }
    | { _tag: 'Err', issues: WideEventSourceIssue[] }

export type TransformWideEventSourceResult
  = | { _tag: 'Ok', source: string }
    | { _tag: 'Err', issues: WideEventSourceIssue[] }

export function validateWideEventSource(
  source: string,
  file: string,
  allowedFields: ReadonlySet<string>,
): ValidateWideEventSourceResult {
  const analysis = analyzeWideEventSource(source, file, allowedFields)
  return analysis.issues.length > 0 ? { _tag: 'Err', issues: analysis.issues } : { _tag: 'Ok' }
}

export function transformWideEventSource(
  source: string,
  file: string,
  allowedFields: ReadonlySet<string>,
): TransformWideEventSourceResult {
  const analysis = analyzeWideEventSource(source, file, allowedFields)
  if (analysis.issues.length > 0)
    return { _tag: 'Err', issues: analysis.issues }
  let output = source
  for (const insertion of analysis.ownedCallEnds.sort((a, b) => b.offset - a.offset))
    output = `${output.slice(0, insertion.offset)}${insertion.text}${output.slice(insertion.offset)}`
  return { _tag: 'Ok', source: output }
}

function analyzeWideEventSource(
  source: string,
  file: string,
  allowedFields: ReadonlySet<string>,
): { issues: WideEventSourceIssue[], ownedCallEnds: SourceInsertion[] } {
  if (
    !source.includes(ADD_FIELDS_API_NAME)
    && !source.includes(CREATE_API_NAME)
    && !source.includes(PACKAGE_SERVER_EXPORT)
    && !source.includes(PACKAGE_STANDALONE_EXPORT)
    && ![...NUXT_SERVER_IMPORTS].some(importSource => source.includes(importSource))
  ) {
    return { issues: [], ownedCallEnds: [] }
  }

  const parsed = parseSync(file, source, {
    lang: languageFor(file),
    sourceType: 'module',
  })
  if (parsed.errors.length > 0) {
    return {
      issues: parsed.errors.map(error => ({
        _tag: 'ParseFailure',
        file,
        line: 1,
        message: error.message,
      })),
      ownedCallEnds: [],
    }
  }

  const issues: WideEventSourceIssue[] = []
  const ownedCallEnds: SourceInsertion[] = []
  const rootScope = createScope(undefined)
  collectStatementBindings(parsed.program.body ?? [], rootScope)
  visitNode(parsed.program, rootScope, source, file, allowedFields, issues, ownedCallEnds)

  return { issues, ownedCallEnds }
}

export function formatWideEventSourceIssues(issues: readonly WideEventSourceIssue[]): string {
  return issues.map((issue) => {
    const location = `${issue.file}:${issue.line}`
    if (issue._tag === 'UnknownField')
      return `${location} Field "${issue.field}" is not configured in wideEvents.fields.`
    if (issue._tag === 'DynamicFields')
      return `${location} addWideEventFields() requires an object literal.`
    if (issue._tag === 'InvalidApiReference')
      return `${location} Wide Event APIs must be called directly.`
    if (issue._tag === 'NonDataField')
      return `${location} Wide Event Fields must use data properties.`
    if (issue._tag === 'SpreadFields')
      return `${location} Wide Event fields cannot use object spreads.`
    if (issue._tag === 'ComputedField')
      return `${location} Wide Event field names must be literals.`
    if (issue._tag === 'DuplicateField')
      return `${location} Field "${issue.field}" appears more than once.`
    return `${location} ${issue.message}`
  }).join('\n')
}

type ApiBinding = 'AddFieldsApi' | 'CreateApi'
type Binding = ApiBinding | 'Local' | 'NuxtNamespace' | 'ServerNamespace' | 'StandaloneNamespace'

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
  const namespaceBinding = source === PACKAGE_SERVER_EXPORT
    ? 'ServerNamespace'
    : source === PACKAGE_STANDALONE_EXPORT
      ? 'StandaloneNamespace'
      : NUXT_SERVER_IMPORTS.has(source)
        ? 'NuxtNamespace'
        : undefined
  for (const specifier of node.specifiers ?? []) {
    const local = specifier.local?.name
    if (!local)
      continue
    if (node.importKind === 'type' || specifier.importKind === 'type') {
      bindName(local, 'Local', scope)
      continue
    }
    if (specifier.type === 'ImportNamespaceSpecifier') {
      bindName(local, namespaceBinding ?? 'Local', scope)
      continue
    }
    const imported = propertyName(specifier.imported)
    bindName(local, importedApiBinding(source, imported) ?? 'Local', scope)
  }
}

function importedApiBinding(source: unknown, imported: unknown): ApiBinding | undefined {
  if (source === PACKAGE_STANDALONE_EXPORT)
    return imported === CREATE_API_NAME ? 'CreateApi' : undefined
  if (source === PACKAGE_SERVER_EXPORT)
    return imported === ADD_FIELDS_API_NAME ? 'AddFieldsApi' : undefined
  if (typeof source === 'string' && NUXT_SERVER_IMPORTS.has(source)) {
    const binding = apiBinding(imported)
    return isApiBinding(binding) ? binding : undefined
  }
}

function isProtectedPackage(source: unknown): boolean {
  return source === PACKAGE_SERVER_EXPORT || source === PACKAGE_STANDALONE_EXPORT
}

function isValueExport(node: AstNode): boolean {
  if (node.exportKind === 'type')
    return false
  if (node.type === 'ExportNamedDeclaration' && node.specifiers?.length > 0)
    return node.specifiers.some((specifier: AstNode) => specifier.exportKind !== 'type')
  return true
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
  ownedCallEnds: SourceInsertion[],
): void {
  if (!node)
    return

  if (node.type === 'ImportDeclaration')
    return
  if (node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration') {
    if (isProtectedPackage(node.source?.value) && isValueExport(node)) {
      issues.push({ _tag: 'InvalidApiReference', file, line: lineAt(source, node.start) })
      return
    }
    visitNode(node.declaration, scope, source, file, allowedFields, issues, ownedCallEnds)
    for (const specifier of node.specifiers ?? []) {
      if (specifier.exportKind !== 'type')
        visitNode(specifier.local, scope, source, file, allowedFields, issues, ownedCallEnds)
    }
    return
  }
  if (node.type === 'ImportExpression') {
    if (isProtectedPackage(node.source?.value)) {
      issues.push({ _tag: 'InvalidApiReference', file, line: lineAt(source, node.start) })
      return
    }
  }
  if (node.type === 'Program') {
    visitChildren(node.body, scope, source, file, allowedFields, issues, ownedCallEnds)
    return
  }
  if (node.type === 'BlockStatement') {
    const blockScope = createScope(scope)
    collectStatementBindings(node.body ?? [], blockScope)
    visitChildren(node.body, blockScope, source, file, allowedFields, issues, ownedCallEnds)
    return
  }
  if (isFunction(node)) {
    const functionScope = createScope(scope)
    bindName(node.id?.name, 'Local', functionScope)
    for (const parameter of node.params ?? []) {
      collectPatternBindings(parameter, functionScope)
    }
    for (const parameter of node.params ?? [])
      visitPatternExpressions(parameter, functionScope, source, file, allowedFields, issues, ownedCallEnds)
    visitNode(node.body, functionScope, source, file, allowedFields, issues, ownedCallEnds)
    return
  }
  if (node.type === 'CatchClause') {
    const catchScope = createScope(scope)
    collectPatternBindings(node.param, catchScope)
    visitNode(node.body, catchScope, source, file, allowedFields, issues, ownedCallEnds)
    return
  }
  if (node.type === 'Identifier') {
    const binding = resolveApiBinding(node.name, scope)
    if (isApiBinding(binding) || isNamespaceBinding(binding))
      issues.push({ _tag: 'InvalidApiReference', file, line: lineAt(source, node.start) })
    return
  }
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    visitMemberExpression(node, scope, source, file, allowedFields, issues, ownedCallEnds)
    return
  }
  if (node.type === 'Property') {
    if (node.computed)
      visitNode(node.key, scope, source, file, allowedFields, issues, ownedCallEnds)
    visitNode(node.value, scope, source, file, allowedFields, issues, ownedCallEnds)
    return
  }
  if (node.type === 'VariableDeclarator') {
    visitPatternExpressions(node.id, scope, source, file, allowedFields, issues, ownedCallEnds)
    visitNode(node.init, scope, source, file, allowedFields, issues, ownedCallEnds)
    return
  }
  if (isTypeScriptExpression(node)) {
    visitNode(node.expression, scope, source, file, allowedFields, issues, ownedCallEnds)
    return
  }
  if (node.type.startsWith('TS'))
    return
  if (node.type === 'CallExpression') {
    const callee = unwrap(node.callee)
    if (callee?.type === 'Identifier' && callee.name === 'require' && isProtectedPackage(node.arguments?.[0]?.value)) {
      issues.push({ _tag: 'InvalidApiReference', file, line: lineAt(source, node.start) })
      return
    }
    if (callee?.type === 'Identifier') {
      const binding = resolveApiBinding(callee.name, scope)
      if (binding === 'AddFieldsApi') {
        validateFieldsArgument(node.arguments?.[1], source, file, allowedFields, issues)
        markCompilerOwnedCall(node, source, file, issues, ownedCallEnds)
        visitChildren(node.arguments, scope, source, file, allowedFields, issues, ownedCallEnds)
        return
      }
      else if (binding === 'CreateApi' && node.arguments?.length > 0) {
        validateFieldsArgument(node.arguments[0], source, file, allowedFields, issues)
        visitChildren(node.arguments, scope, source, file, allowedFields, issues, ownedCallEnds)
        return
      }
      else if (binding === 'CreateApi') {
        return
      }
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'start' || key === 'end')
      continue
    visitUnknown(value, scope, source, file, allowedFields, issues, ownedCallEnds)
  }
}

function markCompilerOwnedCall(
  node: AstNode,
  source: string,
  file: string,
  issues: WideEventSourceIssue[],
  insertions: SourceInsertion[],
): void {
  const arguments_ = node.arguments ?? []
  if (arguments_.length === 3 && arguments_[2]?.type === 'Literal' && arguments_[2].value === true)
    return
  if (arguments_.length !== 2) {
    issues.push({ _tag: 'InvalidApiReference', file, line: lineAt(source, node.start) })
    return
  }
  const fieldsEnd = arguments_[1]?.end
  if (typeof fieldsEnd !== 'number')
    return
  insertions.push({ offset: fieldsEnd, text: ', true' })
}

function visitMemberExpression(
  node: AstNode,
  scope: Scope,
  source: string,
  file: string,
  allowedFields: ReadonlySet<string>,
  issues: WideEventSourceIssue[],
  ownedCallEnds: SourceInsertion[],
): void {
  const object = unwrap(node.object)
  if (object?.type === 'Identifier') {
    const binding = resolveBinding(scope, object.name)
    if (isNamespaceBinding(binding)) {
      const property = node.computed ? undefined : propertyName(node.property)
      if (node.computed || namespaceExposesApi(binding, property))
        issues.push({ _tag: 'InvalidApiReference', file, line: lineAt(source, node.start) })
      if (node.computed)
        visitNode(node.property, scope, source, file, allowedFields, issues, ownedCallEnds)
      return
    }
  }
  visitNode(node.object, scope, source, file, allowedFields, issues, ownedCallEnds)
  if (node.computed)
    visitNode(node.property, scope, source, file, allowedFields, issues, ownedCallEnds)
}

function visitPatternExpressions(
  input: AstNode | undefined,
  scope: Scope,
  source: string,
  file: string,
  allowedFields: ReadonlySet<string>,
  issues: WideEventSourceIssue[],
  ownedCallEnds: SourceInsertion[],
): void {
  const node = unwrap(input)
  if (!node || node.type === 'Identifier')
    return
  if (node.type === 'AssignmentPattern') {
    visitPatternExpressions(node.left, scope, source, file, allowedFields, issues, ownedCallEnds)
    visitNode(node.right, scope, source, file, allowedFields, issues, ownedCallEnds)
    return
  }
  if (node.type === 'RestElement') {
    visitPatternExpressions(node.argument, scope, source, file, allowedFields, issues, ownedCallEnds)
    return
  }
  if (node.type === 'ArrayPattern') {
    for (const element of node.elements ?? [])
      visitPatternExpressions(element, scope, source, file, allowedFields, issues, ownedCallEnds)
    return
  }
  if (node.type === 'ObjectPattern') {
    for (const property of node.properties ?? []) {
      if (property.type === 'RestElement') {
        visitPatternExpressions(property.argument, scope, source, file, allowedFields, issues, ownedCallEnds)
        continue
      }
      if (property.computed)
        visitNode(property.key, scope, source, file, allowedFields, issues, ownedCallEnds)
      visitPatternExpressions(property.value, scope, source, file, allowedFields, issues, ownedCallEnds)
    }
  }
}

function visitChildren(
  nodes: readonly AstNode[] | undefined,
  scope: Scope,
  source: string,
  file: string,
  allowedFields: ReadonlySet<string>,
  issues: WideEventSourceIssue[],
  ownedCallEnds: SourceInsertion[],
): void {
  for (const node of nodes ?? [])
    visitNode(node, scope, source, file, allowedFields, issues, ownedCallEnds)
}

function visitUnknown(
  value: unknown,
  scope: Scope,
  source: string,
  file: string,
  allowedFields: ReadonlySet<string>,
  issues: WideEventSourceIssue[],
  ownedCallEnds: SourceInsertion[],
): void {
  if (Array.isArray(value)) {
    for (const item of value)
      visitUnknown(item, scope, source, file, allowedFields, issues, ownedCallEnds)
    return
  }
  if (value && typeof value === 'object' && 'type' in value)
    visitNode(value as AstNode, scope, source, file, allowedFields, issues, ownedCallEnds)
}

function resolveApiBinding(name: unknown, scope: Scope): Binding | undefined {
  if (typeof name !== 'string')
    return undefined
  const binding = resolveBinding(scope, name)
  if (binding)
    return binding
  return apiBinding(name)
}

function apiBinding(name: unknown): Binding | undefined {
  if (name === ADD_FIELDS_API_NAME)
    return 'AddFieldsApi'
  if (name === CREATE_API_NAME)
    return 'CreateApi'
  return undefined
}

function isApiBinding(binding: Binding | undefined): binding is ApiBinding {
  return binding === 'AddFieldsApi' || binding === 'CreateApi'
}

function isNamespaceBinding(binding: Binding | undefined): binding is 'NuxtNamespace' | 'ServerNamespace' | 'StandaloneNamespace' {
  return binding === 'NuxtNamespace' || binding === 'ServerNamespace' || binding === 'StandaloneNamespace'
}

function namespaceExposesApi(binding: Binding, property: string | undefined): boolean {
  if (property === CREATE_API_NAME)
    return isNamespaceBinding(binding)
  return property === ADD_FIELDS_API_NAME && binding !== 'StandaloneNamespace'
}

function isTypeScriptExpression(node: AstNode): boolean {
  return node.type === 'TSAsExpression'
    || node.type === 'TSInstantiationExpression'
    || node.type === 'TSNonNullExpression'
    || node.type === 'TSSatisfiesExpression'
    || node.type === 'TSTypeAssertion'
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
    if (property.kind !== 'init' || property.method === true) {
      issues.push({ _tag: 'NonDataField', file, line })
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
