import type { RequestEvent } from 'nuxt/server'
import { createCacheableContentResponse } from '../shared/protocol'

export function sendCacheableContent<T>(event: Pick<RequestEvent, 'req' | 'res'>, value: T): T | null {
  const response = createCacheableContentResponse(
    value,
    event.req.headers.get('if-none-match') ?? undefined,
    // Nitro replaces this expression during the server build.
    // eslint-disable-next-line node/prefer-global/process
    process.env.NODE_ENV === 'development' ? { _tag: 'NoStore' } : { _tag: 'Immutable' },
  )
  event.res.status = response.status
  for (const [name, value] of Object.entries(response.headers))
    event.res.headers.set(name, value)
  return response.body
}
