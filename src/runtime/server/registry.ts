import type {
  AnyEventDefinition,
  AnyListenerDefinition,
  GeneratedEventEntry,
  GeneratedEventRegistry,
  GeneratedListenerEntry,
} from './types'

export interface GeneratedRegistryInput {
  manifestHash: string
  events: GeneratedEventEntry[]
  listeners: GeneratedListenerEntry[]
}

export function createGeneratedEventRegistry(input: GeneratedRegistryInput): GeneratedEventRegistry {
  const eventCache = new Map<string, Promise<AnyEventDefinition>>()
  const listenerCache = new Map<string, Promise<AnyListenerDefinition>>()
  const events = Object.create(null) as Record<string, GeneratedEventEntry>
  const listenersByEvent = Object.create(null) as Record<string, GeneratedListenerEntry[]>
  const listenersByName = Object.create(null) as Record<string, GeneratedListenerEntry>

  for (const entry of input.events) {
    events[entry.name] = Object.freeze({
      ...entry,
      load: () => loadCached(eventCache, entry.name, entry.load),
    })
  }
  for (const entry of input.listeners) {
    const cachedEntry: GeneratedListenerEntry = Object.freeze({
      ...entry,
      load: () => loadCached(listenerCache, entry.name, entry.load),
    })
    listenersByName[entry.name] = cachedEntry
    ;(listenersByEvent[entry.event] ??= []).push(cachedEntry)
  }

  for (const entries of Object.values(listenersByEvent))
    Object.freeze(entries)

  return Object.freeze({
    manifestHash: input.manifestHash,
    events: Object.freeze(events),
    listenersByEvent: Object.freeze(listenersByEvent),
    listenersByName: Object.freeze(listenersByName),
  })
}

function loadCached<Value>(cache: Map<string, Promise<Value>>, key: string, load: () => Promise<Value>): Promise<Value> {
  const existing = cache.get(key)
  if (existing)
    return existing
  const pending = load().catch((error) => {
    if (cache.get(key) === pending)
      cache.delete(key)
    throw error
  })
  cache.set(key, pending)
  return pending
}
