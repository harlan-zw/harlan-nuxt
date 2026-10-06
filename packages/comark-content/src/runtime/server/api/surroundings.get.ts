import { defineEventHandler } from 'nuxt/server'
import { createSurroundings } from '../../core/navigation'
import { parseSurroundingsRequest } from '../../shared/protocol'
import { sendCacheableContent } from '../cache'
import { loadNavigationCollection } from '../storage'

export default defineEventHandler(async (event) => {
  const query = event.url.searchParams
  const request = parseSurroundingsRequest(event.context.params?.collection, query.get('path'), query.get('fields') ?? undefined)
  const surroundings = createSurroundings(await loadNavigationCollection(request.collection), request.path, request.fields)
  return sendCacheableContent(event, surroundings)
})
