import { parseSync, Visitor } from 'vite'

const API_NAME = 'addWideEventFields'
const PACKAGE_SERVER_EXPORT = '@harlan-zw/nuxt-wide-events/server'

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

  const importedAliases = new Set<string>()
  const localBindings = new Set<string>()
  const calls: AstNode[] = []
  new Visitor({
    ImportDeclaration(node) {
      collectBindings(node as AstNode, importedAliases, localBindings)
    },
    VariableDeclarator(node) {
      collectBindings(node as AstNode, importedAliases, localBindings)
    },
    FunctionDeclaration(node) {
      collectBindings(node as AstNode, importedAliases, localBindings)
    },
    ClassDeclaration(node) {
      collectBindings(node as AstNode, importedAliases, localBindings)
    },
    CallExpression(node) {
      calls.push(node as AstNode)
    },
  }).visit(parsed.program)

  const callNames = new Set(importedAliases)
  if (!localBindings.has(API_NAME))
    callNames.add(API_NAME)

  const issues: WideEventSourceIssue[] = []
  for (const node of calls) {
    if (node.callee?.type === 'Identifier' && callNames.has(node.callee.name))
      validateFieldsArgument(node.arguments?.[1], source, file, allowedFields, issues)
  }

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

function collectBindings(node: AstNode, importedAliases: Set<string>, localBindings: Set<string>): void {
  if (node.type === 'ImportDeclaration') {
    const packageImport = node.source?.value === PACKAGE_SERVER_EXPORT
    for (const specifier of node.specifiers ?? []) {
      const local = specifier.local?.name
      if (!local)
        continue
      const imported = propertyName(specifier.imported)
      if (packageImport && imported === API_NAME)
        importedAliases.add(local)
      else if (local === API_NAME)
        localBindings.add(local)
    }
    return
  }

  if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.id.name === API_NAME)
    localBindings.add(API_NAME)
  if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id?.name === API_NAME)
    localBindings.add(API_NAME)
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
