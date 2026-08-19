import { defineEventHandler } from '#imports'
import { createNavigation } from '../../core/navigation'
import { parseNavigationRequest } from '../../shared/protocol'
import { sendCacheableContent } from '../cache'
import { loadNavigationCollection } from '../storage'

export default defineEventHandler(async (event) => {
  const node = event.node
  if (!node?.req || !node.res)
    throw new TypeError('<request>:1:1 Expected a Nitro request context.')
  const fields = new URL(node.req.url ?? '/', 'http://comark-content.local').searchParams.get('fields') ?? undefined
  const request = parseNavigationRequest(event.context.params?.collection, fields)
  const navigation = createNavigation(await loadNavigationCollection(request.collection), request.fields)
  return sendCacheableContent(event, navigation)
})
