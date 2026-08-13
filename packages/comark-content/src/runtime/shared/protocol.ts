import type { QueryPlan, QueryOperation } from '../core/query'

export type QueryRequest =
  | { _tag: 'Query', collection: string, plan: QueryPlan }
  | { _tag: 'Navigation', collection: string, fields: string[] }
  | { _tag: 'Surroundings', collection: string, path: string, fields: string[] }
  | { _tag: 'SearchSections', collection: string }

const operators = new Set(['=', '<>', 'LIKE', 'IS NULL'])
const directions = new Set(['ASC', 'DESC'])

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
  if (typeof request.collection !== 'string' || !request.collection)
    throw new TypeError('<request>:1:1 Expected a collection name.')
  if (request._tag === 'Query') {
    const plan = request.plan as Record<string, unknown> | undefined
    if (!Array.isArray(plan?.operations) || !plan.operations.every(isOperation))
      throw new TypeError('<request>:1:1 Expected valid query operations.')
    return request as QueryRequest
  }
  if (request._tag === 'Navigation') {
    if (!Array.isArray(request.fields) || !request.fields.every(field => typeof field === 'string'))
      throw new TypeError('<request>:1:1 Expected navigation fields.')
    return request as QueryRequest
  }
  if (request._tag === 'Surroundings') {
    if (typeof request.path !== 'string' || !Array.isArray(request.fields) || !request.fields.every(field => typeof field === 'string'))
      throw new TypeError('<request>:1:1 Expected a path and surroundings fields.')
    return request as QueryRequest
  }
  if (request._tag === 'SearchSections')
    return request as QueryRequest
  throw new TypeError('<request>:1:1 Unsupported comark-content query.')
}
