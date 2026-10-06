import type { RequestEvent } from 'nuxt/server'

interface NodeHeaderEvent {
  path: string
  node: {
    req: { headers: Record<string, string | string[] | undefined> }
    res: {
      statusCode: number
      getHeader: (name: string) => string | string[] | number | undefined
      setHeader: (name: string, value: string) => unknown
    }
  }
}

type PortableHeaderEvent = Pick<RequestEvent, 'req' | 'res'> & { path: string }
export type HeaderEvent = NodeHeaderEvent | PortableHeaderEvent

function isPortableEvent(event: HeaderEvent): event is PortableHeaderEvent {
  return 'res' in event && typeof event.res.headers?.get === 'function'
}

export function getHeader(event: HeaderEvent, name: string): string | undefined {
  if (!isPortableEvent(event)) {
    const value = event.node.req.headers[name]
    return Array.isArray(value) ? value.join(', ') : value
  }
  return event.req.headers.get(name) ?? undefined
}

export function getResponseHeader(event: HeaderEvent, name: string): string | undefined {
  if (!isPortableEvent(event)) {
    const value = event.node.res.getHeader(name)
    return value === undefined ? undefined : String(value)
  }
  return event.res.headers.get(name) ?? undefined
}

export function getResponseStatus(event: HeaderEvent): number {
  return isPortableEvent(event) ? event.res.status ?? 200 : event.node.res.statusCode
}

export function setResponseHeader(event: HeaderEvent, name: string, value: string): void {
  if (!isPortableEvent(event))
    event.node.res.setHeader(name, value)
  else
    event.res.headers.set(name, value)
}
