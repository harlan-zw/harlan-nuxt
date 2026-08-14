import { createSurroundings } from '../../core/navigation'
import { parseSurroundingsRequest } from '../../shared/protocol'
import { sendCacheableContent } from '../cache'
import { loadNavigationCollection } from '../storage'
import { defineEventHandler } from '#imports'

export default defineEventHandler(async (event) => {
  const node = event.node
  if (!node?.req)
    throw new TypeError('<request>:1:1 Expected a Nitro request context.')
  const query = new URL(node.req.url ?? '/', 'http://comark-content.local').searchParams
  const request = parseSurroundingsRequest(event.context.params?.collection, query.get('path'), query.get('fields') ?? undefined)
  const surroundings = createSurroundings(await loadNavigationCollection(request.collection), request.path, request.fields)
  return sendCacheableContent(event, surroundings)
})
