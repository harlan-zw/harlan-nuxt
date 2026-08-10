import {
  assertLiteralObjectMetadata,
  booleanValue,
  findDefaultExportObjectCall,
  findObjectCalls,
  getObjectKeys,
  getObjectValue,
  hasObjectKey,
  numberValue,
  objectValue,
  parseStaticModule,
  stringValue,
} from './static-ast'

const EVENT_KEYS = new Set(['name', 'transport', 'input', 'codec', 'enabled'])
const LOCAL_TRANSPORT_KEYS = new Set(['_tag'])
const TRANSFER_TRANSPORT_KEYS = new Set(['_tag', 'version', 'maxBytes'])

export interface EventStaticMeta {
  name: string
  enabled: boolean
  transport: { _tag: 'local' } | { _tag: 'transfer', version: number, maxBytes: number }
}

export function extractEventMeta(source: string, filename: string): EventStaticMeta {
  const ast = parseStaticModule(source, filename)
  const calls = findObjectCalls(ast, 'defineEvent')
  if (calls.length !== 1)
    throw new Error(`${filename} must contain exactly one defineEvent({...}) call`)
  const definition = findDefaultExportObjectCall(ast, 'defineEvent')
  if (!definition)
    throw new Error(`${filename} must default-export defineEvent({...})`)
  assertLiteralObjectMetadata(definition, `${filename} defineEvent`)
  assertKnownKeys(definition, EVENT_KEYS, `${filename} defineEvent`)

  const enabledNode = getObjectValue(definition, 'enabled')
  const enabled = enabledNode === undefined ? true : booleanValue(enabledNode)
  if (enabled === undefined)
    throw new Error(`${filename} event enabled must be a boolean literal`)

  const name = stringValue(getObjectValue(definition, 'name'))
  if (!name)
    throw new Error(`${filename} event name must be a non-empty string literal`)

  const transport = objectValue(getObjectValue(definition, 'transport'))
  if (!transport)
    throw new Error(`${filename} event transport must be a literal object`)
  assertLiteralObjectMetadata(transport, `${filename} event transport`)
  const tag = stringValue(getObjectValue(transport, '_tag'))
  if (tag === 'local') {
    assertKnownKeys(transport, LOCAL_TRANSPORT_KEYS, `${filename} local transport`)
    if (!hasObjectKey(definition, 'input'))
      throw new Error(`${filename} local event must declare input`)
    if (hasObjectKey(definition, 'codec'))
      throw new Error(`${filename} local event cannot declare codec`)
    return { name, enabled, transport: { _tag: 'local' } }
  }
  if (tag === 'transfer') {
    assertKnownKeys(transport, TRANSFER_TRANSPORT_KEYS, `${filename} transfer transport`)
    const version = numberValue(getObjectValue(transport, 'version'))
    if (!Number.isInteger(version) || (version ?? 0) < 1)
      throw new Error(`${filename} transfer event version must be a positive integer literal`)
    const maxBytesNode = getObjectValue(transport, 'maxBytes')
    const maxBytes = maxBytesNode === undefined ? 65_536 : numberValue(maxBytesNode)
    if (!Number.isInteger(maxBytes) || (maxBytes ?? 0) < 1)
      throw new Error(`${filename} transfer event maxBytes must be a positive integer literal`)
    if (!hasObjectKey(definition, 'codec'))
      throw new Error(`${filename} transfer event must declare codec`)
    if (hasObjectKey(definition, 'input'))
      throw new Error(`${filename} transfer event cannot declare input`)
    return { name, enabled, transport: { _tag: 'transfer', version: version!, maxBytes: maxBytes! } }
  }
  throw new Error(`${filename} event transport._tag must be "local" or "transfer"`)
}

function assertKnownKeys(object: Parameters<typeof getObjectKeys>[0], allowed: Set<string>, label: string): void {
  const unknown = getObjectKeys(object).filter(key => !allowed.has(key))
  if (unknown.length > 0)
    throw new Error(`${label} has unknown option(s): ${unknown.join(', ')}`)
}
