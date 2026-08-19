import {
  booleanLiteralValue,
  findStaticObjectCall,
  getStaticObjectValue,
  hasStaticObjectProperty,
  numberLiteralValue,
  stringLiteralValue,
} from './static-ast'

/**
 * Statically-extracted metadata from a job source file's `defineJob({...})` call.
 *
 * Literal-typed fields are populated only when the corresponding property's value
 * is the expected literal kind. Non-literal or computed values are left undefined.
 */
export interface JobStaticMeta {
  /** Only if the `defineJob` arg has a string-literal `name`. */
  name?: string
  /** Only if the `defineJob` arg has a string-literal `queue`. */
  queue?: string
  /** Only if the arg has a string-literal `jobType`. */
  jobType?: string
  /** Only if the arg has a numeric-literal `tries`. */
  tries?: number
  /** Only if the arg has a boolean-literal `unique`. */
  unique?: boolean
  /** Whether the arg object has an `input` key (any value). */
  hasInput: boolean
  /** Whether the arg object has a `uniqueId` key (any value). */
  hasUniqueId: boolean
  /**
   * Keys the call declares that this build cannot turn into routing metadata:
   * a non-literal value, or a key that no longer exists (`maxAttempts`).
   *
   * Omitted when every declared key was read. The registry turns each entry
   * into a build warning, because the runtime cost is a job that never routes.
   */
  unreadable?: JobStaticMetaKey[]
}

export type JobStaticMetaKey = 'name' | 'queue' | 'jobType' | 'tries' | 'unique' | 'maxAttempts'

function emptyMeta(): JobStaticMeta {
  return { hasInput: false, hasUniqueId: false }
}

/**
 * Statically extract metadata from a job source file's `defineJob({...})` call.
 *
 * Parsing is tolerant: any parse failure (or absence of a `defineJob` call)
 * yields the all-default shape rather than throwing.
 */
export function extractJobMeta(code: string, filename = 'job.ts'): JobStaticMeta {
  const meta = emptyMeta()

  const arg = findStaticObjectCall(code, ['defineJob'], filename)
  if (!arg)
    return meta

  meta.name = stringLiteralValue(getStaticObjectValue(arg, 'name'))
  meta.queue = stringLiteralValue(getStaticObjectValue(arg, 'queue'))
  meta.jobType = stringLiteralValue(getStaticObjectValue(arg, 'jobType'))
  meta.tries = numberLiteralValue(getStaticObjectValue(arg, 'tries'))
  meta.unique = booleanLiteralValue(getStaticObjectValue(arg, 'unique'))
  meta.hasInput = hasStaticObjectProperty(arg, 'input')
  meta.hasUniqueId = hasStaticObjectProperty(arg, 'uniqueId')

  const unreadable: JobStaticMetaKey[] = []
  for (const key of ['name', 'queue', 'jobType', 'tries', 'unique'] as const) {
    if (meta[key] === undefined && hasStaticObjectProperty(arg, key))
      unreadable.push(key)
  }
  // `maxAttempts` is gone, not unreadable. It rides the same channel so one
  // build warning covers every `defineJob` key the registry had to drop.
  if (hasStaticObjectProperty(arg, 'maxAttempts'))
    unreadable.push('maxAttempts')
  if (unreadable.length > 0)
    meta.unreadable = unreadable

  return meta
}
