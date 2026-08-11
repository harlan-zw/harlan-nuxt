import type { H3Event } from 'h3'
import { getResponseHeader, setResponseHeader } from 'h3'
import { defineNitroPlugin } from 'nitropack/runtime'
import { hasExplicitCachePolicy, withHtmlNoStoreHeaders } from '../utils/workers-cache'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('render:response', (response) => {
    response.headers = withHtmlNoStoreHeaders(response.headers)
  })
  nitroApp.hooks.hook('beforeResponse', (event: H3Event) => {
    if (hasExplicitCachePolicy(name => getResponseHeader(event, name)))
      return
    setResponseHeader(event, 'cache-control', 'private, no-store')
    setResponseHeader(event, 'cloudflare-cdn-cache-control', 'no-store')
  })
})
