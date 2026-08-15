import { executeIndexedQueryPlan } from '../../core/query'
import { parseQueryRequest } from '../../shared/protocol'
import { loadCollectionIndex, loadDocumentBody } from '../storage'
import { defineEventHandler, readBody } from '#imports'

export default defineEventHandler(async (event) => {
  const request = parseQueryRequest(await readBody(event))
  return executeIndexedQueryPlan(await loadCollectionIndex(request.collection), request.plan, asset => loadDocumentBody(request.collection, asset))
})
