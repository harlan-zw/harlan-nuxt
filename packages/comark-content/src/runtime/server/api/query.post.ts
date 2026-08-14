import { createSurroundings } from '../../core/navigation'
import { executeIndexedQueryPlan } from '../../core/query'
import { parseQueryRequest } from '../../shared/protocol'
import { loadCollectionIndex, loadDocumentBody, loadNavigationCollection, loadSearchSections } from '../storage'
import { defineEventHandler, readBody } from '#imports'

export default defineEventHandler(async (event) => {
  const request = parseQueryRequest(await readBody(event))
  if (request._tag === 'Query')
    return executeIndexedQueryPlan(await loadCollectionIndex(request.collection), request.plan, asset => loadDocumentBody(request.collection, asset))
  if (request._tag === 'Surroundings')
    return createSurroundings(await loadNavigationCollection(request.collection), request.path, request.fields)
  return loadSearchSections(request.collection)
})
