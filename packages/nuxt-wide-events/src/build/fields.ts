export const BUILT_IN_WIDE_EVENT_FIELDS = [
  'durationMs',
  'error.name',
  'level',
  'method',
  'path',
  'requestId',
  'service',
  'status',
  'timestamp',
] as const

const builtInFields = new Set<string>(BUILT_IN_WIDE_EVENT_FIELDS)
const FIELD_PATTERN = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/

export type WideEventFieldIssue
  = | { _tag: 'DuplicateField', field: string }
    | { _tag: 'InvalidField', field: string }
    | { _tag: 'ReservedField', field: string }

export type ResolveWideEventFieldsResult
  = | { _tag: 'Ok', fields: string[] }
    | { _tag: 'Err', issues: WideEventFieldIssue[] }

export function resolveWideEventFields(input: readonly string[]): ResolveWideEventFieldsResult {
  const fields: string[] = []
  const issues: WideEventFieldIssue[] = []
  const seen = new Set<string>()

  for (const field of input) {
    if (!FIELD_PATTERN.test(field)) {
      issues.push({ _tag: 'InvalidField', field })
      continue
    }
    if (builtInFields.has(field)) {
      issues.push({ _tag: 'ReservedField', field })
      continue
    }
    if (seen.has(field)) {
      issues.push({ _tag: 'DuplicateField', field })
      continue
    }
    seen.add(field)
    fields.push(field)
  }

  return issues.length > 0
    ? { _tag: 'Err', issues }
    : { _tag: 'Ok', fields }
}

export function formatWideEventFieldIssues(issues: readonly WideEventFieldIssue[]): string {
  return issues.map((issue) => {
    if (issue._tag === 'DuplicateField')
      return `Field "${issue.field}" is configured more than once.`
    if (issue._tag === 'ReservedField')
      return `Field "${issue.field}" is built in and cannot be configured.`
    return `Field "${issue.field}" must use dotted lower camel case segments.`
  }).join('\n')
}
