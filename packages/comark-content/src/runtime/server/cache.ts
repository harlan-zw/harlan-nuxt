import { createCacheableContentResponse } from '../shared/protocol'

type CacheableEvent = {
  node?: {
    req?: { headers: Record<string, string | string[] | undefined> }
    res?: { statusCode: number, setHeader: (name: string, value: string) => void }
  }
}

export const sendCacheableContent = <T>(event: CacheableEvent, value: T): T | null => {
  const node = event.node
  if (!node?.req || !node.res)
    throw new TypeError('<request>:1:1 Expected a Nitro request context.')
  const header = node.req.headers['if-none-match']
  const response = createCacheableContentResponse(
    value,
    Array.isArray(header) ? header.join(',') : header,
    process.env.NODE_ENV === 'development' ? { _tag: 'NoStore' } : { _tag: 'Immutable' },
  )
  node.res.statusCode = response.status
  for (const [name, headerValue] of Object.entries(response.headers))
    node.res.setHeader(name, headerValue)
  return response.body
}
