import { isProxy, isRef } from 'vue'

export type PayloadUsageEntry
  = | { key: string, status: 'tracked', read: string[], unread: { key: string, bytes: number | null }[] }
    | { key: string, status: 'skipped', reason: string }

export type PayloadUsageReport
  = | { status: 'complete', entries: PayloadUsageEntry[] }
    | { status: 'unavailable', reason: string }

declare global {
  interface Window {
    __NUXT_DX_PAYLOAD_ENABLED__?: boolean
    __NUXT_DX_PAYLOAD__?: PayloadUsageReport
  }
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

/** Inspect descriptors before Vue helpers, which read marker properties. */
function dataDescriptors(value: object): PropertyDescriptorMap | undefined {
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some(descriptor => !('value' in descriptor)))
    return
  let prototype = Object.getPrototypeOf(value)
  let remaining = 64
  while (prototype) {
    if (--remaining < 0)
      return
    if (Object.getOwnPropertyDescriptor(prototype, 'toJSON'))
      return
    for (const marker of ['__v_raw', '__v_isRef']) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, marker)
      if (descriptor && !('value' in descriptor))
        return
    }
    prototype = Object.getPrototypeOf(prototype)
  }
  if (!isProxy(value) && !isRef(value))
    return descriptors
}

/** Bound traversal, depth, and worst-case JSON output before serializing. */
function jsonSafe(value: unknown, budget: { nodes: number, bytes: number }, seen = new Set<object>(), depth = 0): boolean {
  if (--budget.nodes < 0 || depth > 64)
    return false
  budget.bytes -= typeof value === 'string' ? value.length * 6 + 2 : 32
  if (budget.bytes < 0)
    return false
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value))
    return true
  if ((!plain(value) && !Array.isArray(value)) || seen.has(value))
    return false
  seen.add(value)
  const descriptors = dataDescriptors(value)
  if (!descriptors)
    return false
  // Never revisit aliases. JSON duplicates them, so compact graphs can expand exponentially.
  // Array length bounds sparse arrays, whose holes also produce serialized output.
  if (Array.isArray(value)) {
    budget.nodes -= value.length
    budget.bytes -= value.length * 5
    if (budget.nodes < 0 || budget.bytes < 0)
      return false
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    budget.bytes -= key.length * 6 + 4
    if (budget.bytes < 0 || !jsonSafe(descriptor.value, budget, seen, depth + 1))
      return false
  }
  return true
}

/** Standalone UTF-8 JSON bytes, not compressed transfer savings or additive devalue bytes. */
function estimateBytes(key: string, value: unknown): number | null {
  const budget = { nodes: 10000, bytes: 1024 * 1024 - key.length * 6 - 8 }
  if (!jsonSafe(value, budget))
    return null
  return new TextEncoder().encode(JSON.stringify({ [key]: value })).byteLength
}

/** Find roots reached through nested data properties or collection entries without reading getters. */
function nestedRoots(roots: PropertyDescriptorMap): Set<object> | undefined {
  const rootValues = new Set<object>()
  for (const key of Reflect.ownKeys(roots)) {
    const descriptor = roots[key]!
    if (!('value' in descriptor) || typeof descriptor.value === 'function')
      return
    if (descriptor.value !== null && typeof descriptor.value === 'object')
      rootValues.add(descriptor.value)
  }
  const nested = new Set<object>()
  const visited = new Set<object>()
  const pending = [...rootValues]
  let remaining = 10000
  const visit = (value: unknown): boolean => {
    if (typeof value === 'function')
      return false
    if (value !== null && typeof value === 'object') {
      if (rootValues.has(value))
        nested.add(value)
      if (!visited.has(value))
        pending.push(value)
    }
    return true
  }
  while (pending.length) {
    const value = pending.pop()!
    if (visited.has(value))
      continue
    if (--remaining < 0)
      return
    visited.add(value)
    const prototype = Object.getPrototypeOf(value)
    if (prototype === Map.prototype || prototype === Set.prototype) {
      // Vue collection proxies do not have the native collection internal slots.
      if (!dataDescriptors(value))
        return
      const entries = prototype === Map.prototype ? Map.prototype.entries.call(value) : Set.prototype.entries.call(value)
      for (const [key, entry] of entries) {
        if (--remaining < 0)
          return
        if (!visit(key) || !visit(entry))
          return
      }
    }
    else if (!plain(value) && !Array.isArray(value)) {
      // Custom objects can hide references in internal slots.
      return
    }
    for (const key of Reflect.ownKeys(value)) {
      if (--remaining < 0)
        return
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (!('value' in descriptor))
        return
      if (!visit(descriptor.value))
        return
    }
  }
  return nested
}

/** Wrap only existing, plain payload data objects. Reads of the outer cache do not count. */
export function trackPayloadUsage(data: Record<string, unknown>) {
  let active = true
  let result: PayloadUsageEntry[] | undefined
  const records: { key: string, fields: string[], read: Set<string>, sizes: Map<string, number | null> }[] = []
  const skipped: PayloadUsageEntry[] = []
  const aliases = new Map<object, { proxy: object, read: Set<string> }>()

  const roots = Object.getOwnPropertyDescriptors(data)
  const nested = nestedRoots(roots)
  for (const key of Object.keys(data)) {
    const root = roots[key]!
    const value: unknown = 'value' in root ? root.value : undefined
    if (!nested || (typeof value === 'object' && value !== null && nested.has(value))) {
      skipped.push({ key, status: 'skipped', reason: 'Nested root references or an incomplete reference scan prevent tracking.' })
      continue
    }
    const descriptors = plain(value) ? dataDescriptors(value) : undefined
    if (!descriptors || !plain(value) || !root.writable || !Object.isExtensible(value)
      || Object.values(descriptors).some(descriptor => !descriptor.configurable || !descriptor.writable)) {
      skipped.push({ key, status: 'skipped', reason: 'Only writable roots containing extensible, configurable plain data objects are tracked.' })
      continue
    }
    const fields = Object.keys(value)
    const sizes = new Map(fields.map(field => [field, estimateBytes(field, value[field])]))
    const existing = aliases.get(value)
    const read = existing?.read ?? new Set<string>()
    const mark = (field: PropertyKey) => {
      if (active && typeof field === 'string' && sizes.has(field))
        read.add(field)
    }
    const proxy = existing?.proxy ?? new Proxy(value, {
      get(target, field, receiver) {
        mark(field)
        return Reflect.get(target, field, receiver)
      },
      has(target, field) {
        mark(field)
        return Reflect.has(target, field)
      },
      ownKeys(target) {
        // Enumeration can control rendering without reading values. Count it conservatively.
        fields.forEach(mark)
        return Reflect.ownKeys(target)
      },
      set(target, field, value, receiver) {
        // A write obscures whether the original server value was needed.
        mark(field)
        return Reflect.set(target, field, value, receiver)
      },
      defineProperty(target, field, descriptor) {
        mark(field)
        return Reflect.defineProperty(target, field, descriptor)
      },
      deleteProperty(target, field) {
        mark(field)
        return Reflect.deleteProperty(target, field)
      },
    })
    aliases.set(value, { proxy, read })
    data[key] = proxy
    records.push({ key, fields, read, sizes })
  }

  return {
    finish(): PayloadUsageEntry[] {
      active = false
      result ??= [
        ...records.map(({ key, fields, read, sizes }): PayloadUsageEntry => ({
          key,
          status: 'tracked',
          read: fields.filter(field => read.has(field)),
          unread: fields.filter(field => !read.has(field)).map(key => ({ key, bytes: sizes.get(key) ?? null })),
        })),
        ...skipped,
      ]
      return result
    },
  }
}

export function formatPayloadUsage(entry: Extract<PayloadUsageEntry, { status: 'tracked' }>): string {
  const fields = entry.unread.map(field => `${field.key} (${field.bytes === null ? 'size unavailable' : `~${field.bytes} JSON bytes`})`)
  return `Payload ${JSON.stringify(entry.key)}: not read during hydration: ${fields.join(', ')}.\nReview pick or deferred fetching. Later interactions may need these fields.`
}
