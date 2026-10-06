import { defineEventHandler, readBody } from 'nuxt/server'
import { executeIndexedQueryPlan } from '../../core/query'
import { parseQueryRequest } from '../../shared/protocol'
import { loadCollectionIndex, loadDocumentBody } from '../storage'

export default defineEventHandler(async (event) => {
  const request = parseQueryRequest(await readBody(event))
  return executeIndexedQueryPlan(await loadCollectionIndex(request.collection), request.plan, asset => loadDocumentBody(request.collection, asset))
})
