import type { NitroApp } from 'nitropack/types'
import type { WideEventLike } from './index'
import config from '#wide-events/config'
import { scheduleWideEventDrain } from './drain'
import { captureWideEventError, emitWideEvent, startWideEvent } from './index'
import { shouldEmitWideEvent } from './production-policy'

interface ErrorHookContext {
  event?: RequestEvent
  tags?: string[]
}

interface RequestEvent extends WideEventLike {
  path: string
  node?: { res?: { statusCode?: number } }
  waitUntil: (promise: Promise<unknown>) => void
}

const EXCLUDED_KEY = Symbol('excluded')

export default function wideEventPolicyPlugin(nitroApp: NitroApp): void {
  function output(event: RequestEvent, status: number, path?: string): void {
    if (isExcluded(event))
      return
    const record = emitWideEvent(event, status, config.service, path)
    if (!record || (config.sampling && !shouldEmitWideEvent(record, config.sampling)))
      return
    if (config.console)
      console.log(JSON.stringify(record))
    if (config.drain)
      scheduleWideEventDrain(nitroApp, event, record)
  }

  nitroApp.hooks.hook('request', (event) => {
    const request = event as unknown as RequestEvent
    if (!isExcluded(request))
      startWideEvent(request)
  })

  nitroApp.hooks.hook('error', (error, context: ErrorHookContext) => {
    if (!context.event || isExcluded(context.event))
      return
    captureWideEventError(context.event, error)
    const path = routeTemplate(context.event)
    if (!context.tags?.includes('request') || path === undefined)
      return
    output(context.event, errorStatus(error), path)
  })

  nitroApp.hooks.hook('afterResponse', (event, response) => {
    const request = event as unknown as RequestEvent
    output(
      request,
      (response as { status?: number } | undefined)?.status ?? request.node?.res?.statusCode ?? 200,
      routeTemplate(request),
    )
  })
}

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
  return (event.context.matchedRoute as { path?: string } | undefined)?.path
}

function errorStatus(error: unknown): number {
  if (typeof error !== 'object' || error === null)
    return 500
  const input = error as Record<string, unknown>
  const status = input.statusCode ?? input.status
  return typeof status === 'number' && Number.isInteger(status) ? status : 500
}
