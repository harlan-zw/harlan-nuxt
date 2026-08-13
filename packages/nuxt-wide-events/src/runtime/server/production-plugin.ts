import type { WideEventLike, WideEventRecord } from './index'
import { defineNitroPlugin } from 'nitropack/runtime'
import config from '#wide-events/config'
import { captureWideEventError, emitWideEvent, startWideEvent } from './index'

interface ErrorHookContext {
  event?: WideEventLike
  tags?: string[]
}

interface ServerResponse {
  status?: number
  statusCode?: number
}

export default defineNitroPlugin((nitroApp) => {
  function output(event: WideEventLike, status: number, path?: string): Promise<void> | undefined {
    const record = emitWideEvent(event, status, config.service, path)
    if (!record)
      return
    if (config.console)
      console.log(JSON.stringify(record))
    if (config.drain)
      return drain(nitroApp, record)
  }

  nitroApp.hooks.hook('request', (event) => {
    const request = event as unknown as WideEventLike
    startWideEvent(request)
  })

  nitroApp.hooks.hook('error', (error, context: ErrorHookContext) => {
    if (!context.event)
      return
    captureWideEventError(context.event, error)
    const path = routeTemplate(context.event)
    if (!context.tags?.includes('request') || path === undefined)
      return
    return output(context.event, errorStatus(error), path)
  })

  nitroApp.hooks.hook('afterResponse', (event, response) => {
    const request = event as unknown as WideEventLike
    return output(
      request,
      responseStatus(response as ServerResponse),
      routeTemplate(request),
    )
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

function responseStatus(response?: ServerResponse): number {
  if (typeof response?.status === 'number')
    return response.status
  if (typeof response?.statusCode === 'number')
    return response.statusCode
  return 200
}

function errorStatus(error: unknown): number {
  if (typeof error !== 'object' || error === null)
    return 500
  const input = error as Record<string, unknown>
  const status = input.statusCode ?? input.status
  return typeof status === 'number' && Number.isInteger(status) ? status : 500
}

async function drain(nitroApp: { hooks: { callHook: (...input: any[]) => Promise<unknown> } }, record: WideEventRecord): Promise<void> {
  await nitroApp.hooks.callHook('wide-events:emit', record)
    .catch(error => console.error('[nuxt-wide-events] Wide Event drain failed.', error))
}
