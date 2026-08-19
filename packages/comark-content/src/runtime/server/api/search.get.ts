import { defineEventHandler } from '#imports'
import { parseSearchRequest } from '../../shared/protocol'
import { sendCacheableContent } from '../cache'
import { loadSearchSections } from '../storage'

export default defineEventHandler(async (event) => {
  const request = parseSearchRequest(event.context.params?.collection)
  return sendCacheableContent(event, await loadSearchSections(request.collection))
})
