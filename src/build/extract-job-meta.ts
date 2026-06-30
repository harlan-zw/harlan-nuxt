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

function emptyMeta(): JobStaticMeta {
  return { hasInput: false, hasUniqueId: false }
}

/**
 * Statically extract metadata from a job source file's `defineJob({...})` call.
 *
 * Parsing is tolerant: any parse failure (or absence of a `defineJob` call)
 * yields the all-default shape rather than throwing.
 */
export function extractJobMeta(code: string): JobStaticMeta {
  const meta = emptyMeta()

  const arg = findStaticObjectCall(code, ['defineJob'])
  if (!arg)
    return meta

  meta.name = stringLiteralValue(getStaticObjectValue(arg, 'name'))
  meta.queue = stringLiteralValue(getStaticObjectValue(arg, 'queue'))
  meta.jobType = stringLiteralValue(getStaticObjectValue(arg, 'jobType'))
  meta.maxAttempts = numberLiteralValue(getStaticObjectValue(arg, 'maxAttempts'))
  meta.tries = numberLiteralValue(getStaticObjectValue(arg, 'tries'))
  meta.unique = booleanLiteralValue(getStaticObjectValue(arg, 'unique'))
  meta.hasInput = hasStaticObjectProperty(arg, 'input')
  meta.hasUniqueId = hasStaticObjectProperty(arg, 'uniqueId')

  return meta
}
