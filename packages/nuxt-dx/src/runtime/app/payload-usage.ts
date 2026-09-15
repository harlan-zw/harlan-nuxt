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
  for (const marker of ['__v_raw', '__v_isRef']) {
    const prototype = Object.getPrototypeOf(value)
    const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, marker)
    if (descriptor && !('value' in descriptor))
      return
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

/** Observe value reads in place so aliases and cycles retain their original identity. */
export function trackPayloadUsage(data: Record<string, unknown>) {
  let active = true
  let result: PayloadUsageEntry[] | undefined
  const records: { key: string, fields: string[], read: Set<string>, sizes: Map<string, number | null> }[] = []
  const skipped: PayloadUsageEntry[] = []
  const objects = new Map<object, { descriptors: PropertyDescriptorMap, fields: string[], read: Set<string> }>()
  const cleanup: (() => void)[] = []

  // Estimate all values before installing accessors, including values shared between roots.
  for (const key of Object.keys(data)) {
    const root = Object.getOwnPropertyDescriptor(data, key)
    const value: unknown = root && 'value' in root ? root.value : undefined
    const descriptors = plain(value) ? dataDescriptors(value) : undefined
    if (!descriptors || !plain(value) || !Object.isExtensible(value)
      || Object.values(descriptors).some(descriptor => !descriptor.configurable || !descriptor.writable)) {
      skipped.push({ key, status: 'skipped', reason: 'Only extensible plain objects with configurable, writable data properties are tracked.' })
      continue
    }
    const fields = Object.keys(value)
    const sizes = new Map(fields.map(field => [field, estimateBytes(field, descriptors[field]!.value)]))
    const read = objects.get(value)?.read ?? new Set<string>()
    objects.set(value, { descriptors, fields, read })
    records.push({ key, fields, read, sizes })
  }

  for (const [value, { descriptors, fields, read }] of objects) {
    for (const field of fields) {
      const original = descriptors[field]!
      let current: unknown = original.value
      const get = () => {
        if (active)
          read.add(field)
        return current
      }
      const set = function (this: object, next: unknown) {
        // Freeze and seal both lock accessor descriptors. Never retain a writable frozen value.
        if (!Object.getOwnPropertyDescriptor(value, field)?.configurable)
          throw new TypeError('Cannot write a payload property after it becomes nonconfigurable.')
        if (active)
          read.add(field)
        if (this === value)
          current = next
        else
          Object.defineProperty(this, field, { value: next, writable: true, enumerable: true, configurable: true })
      }
      Object.defineProperty(value, field, { configurable: true, enumerable: original.enumerable, get, set })
      cleanup.push(() => {
        const descriptor = Object.getOwnPropertyDescriptor(value, field)
        if (descriptor?.get !== get || descriptor.set !== set) {
          // Deletion or replacement obscures whether the server value was needed.
          read.add(field)
          return
        }
        if (descriptor.configurable)
          Object.defineProperty(value, field, { ...original, value: current })
      })
    }
  }

  return {
    finish(): PayloadUsageEntry[] {
      if (result)
        return result
      active = false
      cleanup.forEach(restore => restore())
      result = [
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
