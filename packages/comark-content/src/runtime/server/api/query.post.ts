import { createNavigation, createSearchSections, createSurroundings } from '../../core/navigation'
import { executeQueryPlan } from '../../core/query'
import { parseQueryRequest } from '../../shared/protocol'
import { loadCollection } from '../storage'
import { defineEventHandler, readBody } from '#imports'

export default defineEventHandler(async (event) => {
  const request = parseQueryRequest(await readBody(event))
  const collection = await loadCollection(request.collection)
  if (request._tag === 'Query')
    return executeQueryPlan(collection, request.plan)
  if (request._tag === 'Navigation')
    return createNavigation(collection, request.fields)
  if (request._tag === 'Surroundings')
    return createSurroundings(collection, request.path, request.fields)
  return createSearchSections(collection)
})
