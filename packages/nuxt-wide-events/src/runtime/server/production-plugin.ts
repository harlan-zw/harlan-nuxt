import type { NitroApp } from 'nitropack/types'
import type { WideEventLike } from './index'
import config from '#wide-events/config'
import { scheduleWideEventDrain } from './drain'
import { captureWideEventError, emitWideEvent, startWideEvent } from './index'

interface ErrorHookContext {
  event?: RequestEvent
  tags?: string[]
}

interface RequestEvent extends WideEventLike {
  path: string
  node?: { res?: { statusCode?: number } }
  waitUntil: (promise: Promise<unknown>) => void
}

export default function wideEventPlugin(nitroApp: NitroApp): void {
  function output(event: RequestEvent, status: number, path?: string): void {
    const record = emitWideEvent(event, status, config.service, path)
    if (!record)
      return
    if (config.console)
      console.log(JSON.stringify(record))
    if (config.drain)
      scheduleWideEventDrain(nitroApp, event, record)
  }

  nitroApp.hooks.hook('request', (event) => {
    const request = event as unknown as RequestEvent
    startWideEvent(request)
  })

  nitroApp.hooks.hook('error', (error, context: ErrorHookContext) => {
    if (!context.event)
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
