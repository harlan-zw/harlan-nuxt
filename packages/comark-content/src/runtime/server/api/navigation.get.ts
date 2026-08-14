import { createNavigation } from '../../core/navigation'
import { createNavigationEtag, matchesNavigationEtag, parseNavigationRequest } from '../../shared/protocol'
import { loadNavigationCollection } from '../storage'
import { defineEventHandler } from '#imports'

const cacheControl = 'public, max-age=0, must-revalidate'

export default defineEventHandler(async (event) => {
  const node = event.node
  if (!node?.req || !node.res)
    throw new TypeError('<request>:1:1 Expected a Nitro request context.')
  const fields = new URL(node.req.url ?? '/', 'http://comark-content.local').searchParams.get('fields') ?? undefined
  const request = parseNavigationRequest(event.context.params?.collection, fields)
  const navigation = createNavigation(await loadNavigationCollection(request.collection), request.fields)
  const etag = createNavigationEtag(navigation)

  node.res.setHeader('cache-control', cacheControl)
  node.res.setHeader('etag', etag)
  const ifNoneMatch = node.req.headers['if-none-match']
  if (matchesNavigationEtag(Array.isArray(ifNoneMatch) ? ifNoneMatch.join(',') : ifNoneMatch, etag)) {
    node.res.statusCode = 304
    return null
  }
  return navigation
})
