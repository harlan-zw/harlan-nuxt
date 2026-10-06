import { defineEventHandler } from 'nuxt/server'
import { createNavigation } from '../../core/navigation'
import { parseNavigationRequest } from '../../shared/protocol'
import { sendCacheableContent } from '../cache'
import { loadNavigationCollection } from '../storage'

export default defineEventHandler(async (event) => {
  const fields = event.url.searchParams.get('fields') ?? undefined
  const request = parseNavigationRequest(event.context.params?.collection, fields)
  const navigation = createNavigation(await loadNavigationCollection(request.collection), request.fields)
  return sendCacheableContent(event, navigation)
})
