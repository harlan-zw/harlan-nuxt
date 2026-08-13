import type { WideEventLike, WideEventRecord } from './index'
import { defineNitroPlugin } from 'nitropack/runtime'
import config from '#wide-events/config'
import { captureWideEventError, emitWideEvent, startWideEvent } from './index'

interface ErrorHookContext {
  event?: WideEventLike
}

interface ServerEvent extends WideEventLike {
  node?: { res?: { statusCode?: number } }
  response?: { status?: number }
}

interface ServerResponse {
  status?: number
  statusCode?: number
}

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', (event) => {
    const request = event as unknown as WideEventLike
    const requestId = request.context.requestId
    startWideEvent(request, typeof requestId === 'string' ? requestId : undefined)
  })

  nitroApp.hooks.hook('error', (error, context: ErrorHookContext) => {
    if (context.event)
      captureWideEventError(context.event, error)
  })

  nitroApp.hooks.hook('afterResponse', async (event, response) => {
    const request = event as unknown as ServerEvent
    const record = emitWideEvent(
      request,
      responseStatus(request, response as ServerResponse),
      config.service,
      routeTemplate(request),
    )
    if (!record)
      return
    if (config.console)
      console.log(JSON.stringify(record))
    await drain(nitroApp, record)
  })
})

function routeTemplate(event: WideEventLike): string | undefined {
  const route = event.context.matchedRoute
  if (typeof route !== 'object' || route === null)
    return undefined
  const input = route as Record<string, unknown>
  if (typeof input.path === 'string')
    return input.path
  return typeof input.route === 'string' ? input.route : undefined
}

function responseStatus(event: ServerEvent, response: ServerResponse): number {
  if (typeof response.status === 'number')
    return response.status
  if (typeof response.statusCode === 'number')
    return response.statusCode
  if (typeof event.response?.status === 'number')
    return event.response.status
  if (typeof event.node?.res?.statusCode === 'number')
    return event.node.res.statusCode
  return typeof event.context.status === 'number' ? event.context.status : 200
}

async function drain(nitroApp: { hooks: { callHook: (...input: any[]) => Promise<unknown> } }, record: WideEventRecord): Promise<void> {
  await nitroApp.hooks.callHook('wide-events:emit', record)
    .catch(error => console.error('[nuxt-wide-events] Wide Event drain failed.', error))
}
