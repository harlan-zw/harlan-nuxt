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

/** Only inspect data properties. Size measurement must never execute user getters or toJSON methods. */
function jsonSafe(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value))
    return true
  if ((!plain(value) && !Array.isArray(value)) || isProxy(value) || isRef(value) || seen.has(value))
    return false
  seen.add(value)
  const safe = Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor =>
    'value' in descriptor && jsonSafe(descriptor.value, seen),
  )
  seen.delete(value)
  return safe
}

/** Standalone UTF-8 JSON bytes, not compressed transfer savings or additive devalue bytes. */
function estimateBytes(key: string, value: unknown): number | null {
  if (!jsonSafe(value))
    return null
  return new TextEncoder().encode(JSON.stringify({ [key]: value })).byteLength
}

/** Wrap only existing, plain payload data objects. Reads of the outer cache do not count. */
export function trackPayloadUsage(data: Record<string, unknown>) {
  let active = true
  let result: PayloadUsageEntry[] | undefined
  const records: { key: string, fields: string[], read: Set<string>, sizes: Map<string, number | null> }[] = []
  const skipped: PayloadUsageEntry[] = []
  const aliases = new Map<object, { proxy: object, read: Set<string> }>()

  for (const key of Object.keys(data)) {
    const value = data[key]
    if (!plain(value) || isProxy(value) || isRef(value) || !Object.isExtensible(value)
      || Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => !('value' in descriptor))) {
      skipped.push({ key, status: 'skipped', reason: 'Only extensible plain data objects are tracked.' })
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
