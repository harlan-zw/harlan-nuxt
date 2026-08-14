import type { QueryPlan, QueryOperation } from '../core/query'

export type QueryRequest =
  { _tag: 'Query', collection: string, plan: QueryPlan }

export type NavigationRequest = {
  collection: string
  fields: string[]
}

export type SearchRequest = {
  collection: string
}

export type SurroundingsRequest = NavigationRequest & {
  path: string
}

export type CacheableContentResponse<T> =
  | { _tag: 'Fresh', status: 200, body: T, headers: Record<string, string> }
  | { _tag: 'NotModified', status: 304, body: null, headers: Record<'cache-control' | 'cloudflare-cdn-cache-control' | 'etag', string> }

export type ContentCachePolicy =
  | { _tag: 'Immutable' }
  | { _tag: 'NoStore' }

const operators = new Set(['=', '<>', 'LIKE', 'IS NULL'])
const directions = new Set(['ASC', 'DESC'])
const collectionName = /^[A-Za-z][A-Za-z0-9_]*$/
const fieldName = /^[A-Za-z_][A-Za-z0-9_]*$/
const forbiddenFields = new Set(['__proto__', 'constructor', 'prototype'])

const parseCollection = (collection: unknown): string => {
  if (typeof collection !== 'string' || collection.length > 128 || !collectionName.test(collection))
    throw new TypeError('<request>:1:1 Expected a valid collection name.')
  return collection
}

const parseFields = (fields: unknown, subject: string): string[] => {
  if (fields !== undefined && typeof fields !== 'string')
    throw new TypeError(`<request>:1:1 Expected comma-separated ${subject} fields.`)
  const requestedFields = fields ? fields.split(',') : []
  if (requestedFields.length > 32 || requestedFields.some(field => !fieldName.test(field) || forbiddenFields.has(field)))
    throw new TypeError(`<request>:1:1 Expected valid ${subject} fields.`)
  return [...new Set(requestedFields)]
}

export const parseNavigationRequest = (collection: unknown, fields: unknown): NavigationRequest => {
  return { collection: parseCollection(collection), fields: parseFields(fields, 'navigation') }
}

export const parseSearchRequest = (collection: unknown): SearchRequest => ({ collection: parseCollection(collection) })

export const parseSurroundingsRequest = (collection: unknown, path: unknown, fields: unknown): SurroundingsRequest => {
  if (typeof path !== 'string' || path.length > 2048 || !path.startsWith('/'))
    throw new TypeError('<request>:1:1 Expected an absolute content path.')
  return { collection: parseCollection(collection), path, fields: parseFields(fields, 'surroundings') }
}

const createContentEtag = (value: unknown): string => {
  const source = JSON.stringify(value)
  let hash = 0x811C9DC5
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `W/"${source.length.toString(36)}-${(hash >>> 0).toString(36)}"`
}

const matchesContentEtag = (header: string | undefined, etag: string): boolean => header
  ?.split(',')
  .some(candidate => candidate.trim() === etag || candidate.trim() === '*') ?? false

export const createCacheableContentResponse = <T>(
  value: T,
  ifNoneMatch?: string,
  policy: ContentCachePolicy = { _tag: 'Immutable' },
): CacheableContentResponse<T> => {
  if (policy._tag === 'NoStore') {
    return {
      _tag: 'Fresh',
      status: 200,
      body: value,
      headers: {
        'cache-control': 'no-store',
        'cloudflare-cdn-cache-control': 'no-store',
      },
    }
  }
  const etag = createContentEtag(value)
  const headers = {
    'cache-control': 'public, max-age=31536000, immutable',
    'cloudflare-cdn-cache-control': 'public, max-age=31536000, immutable',
    etag,
  }
  return matchesContentEtag(ifNoneMatch, etag)
    ? { _tag: 'NotModified', status: 304, body: null, headers }
    : { _tag: 'Fresh', status: 200, body: value, headers }
}

const isOperation = (value: unknown): value is QueryOperation => {
  if (!value || typeof value !== 'object')
    return false
  const operation = value as Record<string, unknown>
  if (operation._tag === 'Path')
    return typeof operation.value === 'string'
  if (operation._tag === 'Where')
    return typeof operation.field === 'string' && operators.has(String(operation.operator))
  if (operation._tag === 'Order')
    return typeof operation.field === 'string' && directions.has(String(operation.direction))
  if (operation._tag === 'Limit')
    return Number.isSafeInteger(operation.value) && Number(operation.value) >= 0
  return operation._tag === 'Select' && Array.isArray(operation.fields) && operation.fields.every(field => typeof field === 'string')
}

export const parseQueryRequest = (value: unknown): QueryRequest => {
  if (!value || typeof value !== 'object')
    throw new TypeError('<request>:1:1 Expected a comark-content query object.')
  const request = value as Record<string, unknown>
  const collection = parseCollection(request.collection)
  if (request._tag === 'Query') {
    const plan = request.plan as Record<string, unknown> | undefined
    if (!Array.isArray(plan?.operations) || !plan.operations.every(isOperation))
      throw new TypeError('<request>:1:1 Expected valid query operations.')
    return { _tag: 'Query', collection, plan: plan as QueryPlan }
  }
  throw new TypeError('<request>:1:1 Unsupported comark-content query.')
}
