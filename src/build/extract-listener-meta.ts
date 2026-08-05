import type { ListenerExecution } from '../runtime/server/types'
import {
  assertLiteralObjectMetadata,
  booleanValue,
  findDefaultExportObjectCall,
  findObjectCalls,
  getObjectKeys,
  getObjectValue,
  hasObjectKey,
  numberArrayValue,
  numberValue,
  objectValue,
  parseStaticModule,
  stringValue,
} from './static-ast'

const LISTENER_KEYS = new Set([
  'name',
  'event',
  'execution',
  'input',
  'subscriber',
  'middleware',
  'shouldHandle',
  'idempotency',
  'failed',
  'handle',
  'enabled',
])
const SYNC_KEYS = new Set(['_tag', 'failure'])
const DEFERRED_KEYS = new Set(['_tag', 'failure'])
const QUEUED_KEYS = new Set(['_tag', 'queue', 'publication', 'tries', 'backoff'])

export interface ListenerStaticMeta {
  name: string
  event: string
  enabled: boolean
  execution: ListenerExecution
  subscriber?: string
  hasIdempotency: boolean
  hasFailed: boolean
}

export function extractListenerMeta(source: string, filename: string): ListenerStaticMeta {
  const ast = parseStaticModule(source, filename)
  const calls = findObjectCalls(ast, 'defineListener')
  if (calls.length !== 1)
    throw new Error(`${filename} must contain exactly one defineListener({...}) call`)
  const definition = findDefaultExportObjectCall(ast, 'defineListener')
  if (!definition)
    throw new Error(`${filename} must default-export defineListener({...})`)
  assertLiteralObjectMetadata(definition, `${filename} defineListener`)
  assertKnownKeys(definition, LISTENER_KEYS, `${filename} defineListener`)

  const enabledNode = getObjectValue(definition, 'enabled')
  const enabled = enabledNode === undefined ? true : booleanValue(enabledNode)
  if (enabled === undefined)
    throw new Error(`${filename} listener enabled must be a boolean literal`)
  const name = stringValue(getObjectValue(definition, 'name'))
  const event = stringValue(getObjectValue(definition, 'event'))
  if (!name)
    throw new Error(`${filename} listener name must be a non-empty string literal`)
  if (!event)
    throw new Error(`${filename} listener event must be a non-empty string literal`)
  if (!hasObjectKey(definition, 'handle'))
    throw new Error(`${filename} listener must declare handle`)

  const subscriberNode = getObjectValue(definition, 'subscriber')
  const subscriber = subscriberNode === undefined ? undefined : stringValue(subscriberNode)
  if (subscriberNode !== undefined && !subscriber)
    throw new Error(`${filename} listener subscriber must be a non-empty string literal`)

  const executionNode = getObjectValue(definition, 'execution')
  const execution = executionNode === undefined
    ? { _tag: 'sync' as const, failure: 'propagate' as const }
    : parseExecution(executionNode, filename)
  const hasIdempotency = hasObjectKey(definition, 'idempotency')
  const hasFailed = hasObjectKey(definition, 'failed')
  if (execution._tag === 'queued' && !hasIdempotency)
    throw new Error(`${filename} queued listener must declare idempotency`)
  if (execution._tag !== 'queued' && hasIdempotency)
    throw new Error(`${filename} only queued listeners may declare idempotency`)
  if (execution._tag === 'queued' && hasObjectKey(definition, 'shouldHandle'))
    throw new Error(`${filename} queued listener cannot declare shouldHandle; producer-time conditional queueing is deferred in v1`)
  if (execution._tag !== 'queued' && hasFailed)
    throw new Error(`${filename} only queued listeners may declare failed`)

  return { name, event, enabled, execution, subscriber, hasIdempotency, hasFailed }
}

function parseExecution(input: unknown, filename: string): ListenerExecution {
  const execution = objectValue(input)
  if (!execution)
    throw new Error(`${filename} listener execution must be a literal object`)
  assertLiteralObjectMetadata(execution, `${filename} listener execution`)
  const tag = stringValue(getObjectValue(execution, '_tag'))
  if (tag === 'sync') {
    assertKnownKeys(execution, SYNC_KEYS, `${filename} sync execution`)
    const failure = stringValue(getObjectValue(execution, 'failure'))
    if (failure !== 'propagate' && failure !== 'isolate')
      throw new Error(`${filename} sync execution failure must be "propagate" or "isolate"`)
    return { _tag: 'sync', failure }
  }
  if (tag === 'deferred') {
    assertKnownKeys(execution, DEFERRED_KEYS, `${filename} deferred execution`)
    if (stringValue(getObjectValue(execution, 'failure')) !== 'isolate')
      throw new Error(`${filename} deferred execution failure must be "isolate"`)
    return { _tag: 'deferred', failure: 'isolate' }
  }
  if (tag === 'queued') {
    assertKnownKeys(execution, QUEUED_KEYS, `${filename} queued execution`)
    const queue = stringValue(getObjectValue(execution, 'queue'))
    const publication = stringValue(getObjectValue(execution, 'publication'))
    if (!queue)
      throw new Error(`${filename} queued execution queue must be a non-empty string literal`)
    if (publication !== 'immediate' && publication !== 'after-commit')
      throw new Error(`${filename} queued execution publication must be "immediate" or "after-commit"`)
    const tries = optionalPositiveInteger(execution, 'tries', filename)
    const backoffNode = getObjectValue(execution, 'backoff')
    const backoff = backoffNode === undefined ? undefined : numberArrayValue(backoffNode)
    if (backoffNode !== undefined && (!backoff || backoff.length === 0 || backoff.some(value => !Number.isInteger(value) || value < 0)))
      throw new Error(`${filename} queued execution backoff must be a non-empty literal array of non-negative integers`)
    return {
      _tag: 'queued',
      queue,
      publication,
      ...(tries === undefined ? {} : { tries }),
      ...(backoff === undefined ? {} : { backoff }),
    }
  }
  throw new Error(`${filename} listener execution._tag must be "sync", "deferred", or "queued"`)
}

function optionalPositiveInteger(object: Parameters<typeof getObjectValue>[0], key: string, filename: string): number | undefined {
  const node = getObjectValue(object, key)
  if (node === undefined)
    return undefined
  const value = numberValue(node)
  if (!Number.isInteger(value) || (value ?? 0) < 1)
    throw new Error(`${filename} queued execution ${key} must be a positive integer literal`)
  return value
}

function assertKnownKeys(object: Parameters<typeof getObjectKeys>[0], allowed: Set<string>, label: string): void {
  const unknown = getObjectKeys(object).filter(key => !allowed.has(key))
  if (unknown.length > 0)
    throw new Error(`${label} has unknown option(s): ${unknown.join(', ')}`)
}
