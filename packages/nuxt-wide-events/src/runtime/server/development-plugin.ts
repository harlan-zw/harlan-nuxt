import type { WideEventLike, WideEventRecord } from './index'
import { defineNitroPlugin } from 'nitropack/runtime'
import config from '#wide-events/config'
import { enrichDevelopmentWideEvent } from './development'
import { captureWideEventError, emitWideEvent, startWideEvent } from './index'

interface ErrorHookContext {
  event?: WideEventLike
  tags?: string[]
}

interface ServerEvent extends WideEventLike {
  node?: { res?: { statusCode?: number } }
  response?: { status?: number }
}

interface RequestEvent extends WideEventLike {
  path: string
}

interface ServerResponse {
  status?: number
  statusCode?: number
}

const ERROR_KEY = Symbol('developmentError')
const EXCLUDED_KEY = Symbol('excluded')

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', (event) => {
    const request = event as unknown as RequestEvent
    if (isExcluded(request))
      return
    startWideEvent(request)
  })

  nitroApp.hooks.hook('error', (error, context: ErrorHookContext) => {
    if (!context.event || isExcluded(context.event))
      return
    captureWideEventError(context.event, error)
    ;(context.event.context as Record<PropertyKey, unknown>)[ERROR_KEY] = error
    if (!context.tags?.includes('request') || routeTemplate(context.event) === undefined)
      return
    const record = emitWideEvent(
      context.event,
      errorStatus(error),
      config.service,
      routeTemplate(context.event) ?? safePath(context.event.path),
    )
    if (!record)
      return
    enrichDevelopmentWideEvent(record, error)
    if (config.console)
      console.log('Wide Event', record)
    if (config.drain)
      return drain(nitroApp, record)
  })

  nitroApp.hooks.hook('afterResponse', (event, response) => {
    const request = event as unknown as ServerEvent
    if (isExcluded(request))
      return
    const error = (request.context as Record<PropertyKey, unknown>)[ERROR_KEY]
    const record = emitWideEvent(
      request,
      responseStatus(request, response as ServerResponse),
      config.service,
      routeTemplate(request) ?? safePath(request.path),
    )
    if (!record)
      return
    if (error !== undefined)
      enrichDevelopmentWideEvent(record, error)
    if (config.console)
      console.log('Wide Event', record)
    if (config.drain)
      return drain(nitroApp, record)
  })
})

function isExcluded(event: WideEventLike): boolean {
  const context = event.context as Record<PropertyKey, unknown>
  const cached = context[EXCLUDED_KEY]
  if (typeof cached === 'boolean')
    return cached
  const path = event.path ?? ''
  const query = path.indexOf('?')
  const excluded = config.exclude?.test(query === -1 ? path : path.slice(0, query)) ?? false
  context[EXCLUDED_KEY] = excluded
  return excluded
}

function routeTemplate(event: WideEventLike): string | undefined {
  const route = event.context.matchedRoute
  if (typeof route !== 'object' || route === null)
    return undefined
  const input = route as Record<string, unknown>
  if (typeof input.path === 'string')
    return input.path
  return typeof input.route === 'string' ? input.route : undefined
}

function safePath(path: string | undefined): string {
  if (path === undefined)
    return '/'
  const queryIndex = path.indexOf('?')
  return queryIndex === -1 ? path : path.slice(0, queryIndex)
}

function responseStatus(event: ServerEvent, response?: ServerResponse): number {
  if (typeof response?.status === 'number')
    return response.status
  if (typeof response?.statusCode === 'number')
    return response.statusCode
  if (typeof event.response?.status === 'number')
    return event.response.status
  if (typeof event.node?.res?.statusCode === 'number')
    return event.node.res.statusCode
  return typeof event.context.status === 'number' ? event.context.status : 200
}

function errorStatus(error: unknown): number {
  if (typeof error !== 'object' || error === null)
    return 500
  const input = error as Record<string, unknown>
  if (typeof input.statusCode === 'number' && Number.isInteger(input.statusCode))
    return input.statusCode
  if (typeof input.status === 'number' && Number.isInteger(input.status))
    return input.status
  return 500
}

async function drain(nitroApp: { hooks: { callHook: (...input: any[]) => Promise<unknown> } }, record: WideEventRecord): Promise<void> {
  await nitroApp.hooks.callHook('wide-events:emit', record)
    .catch(error => console.error('[nuxt-wide-events] Wide Event drain failed.', error))
}
