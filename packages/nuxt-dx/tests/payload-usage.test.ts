import { describe, expect, it } from 'vitest'
import { reactive, readonly, ref, shallowReactive, shallowReadonly, shallowRef, toRaw } from 'vue'
import { trackPayloadUsage } from '../src/runtime/app/payload-usage'

describe('payload reads', () => {
  it('reports untouched fields without treating cache reads as field reads', () => {
    const data = { product: { title: 'Book', details: 'Long details' } }
    const tracker = trackPayloadUsage(data)
    const cached = shallowRef(data.product)
    expect(cached.value.title).toBe('Book')
    expect(tracker.finish()).toEqual([{
      key: 'product',
      status: 'tracked',
      read: ['title'],
      unread: [{ key: 'details', bytes: 26 }],
    }])
    expect(data.product.details).toBe('Long details')
    expect(tracker.finish()[0]).toMatchObject({ unread: [{ key: 'details' }] })
  })

  it('preserves Vue deep reactivity and stops collecting after hydration', () => {
    const data = { product: { title: 'Book', details: { text: 'Details' } } }
    const tracker = trackPayloadUsage(data)
    const value = ref(data.product)
    expect(value.value.title).toBe('Book')
    const report = tracker.finish()
    value.value.details.text = 'Changed'
    expect(value.value.details.text).toBe('Changed')
    expect(tracker.finish()).toEqual(report)
  })

  it('counts value reads from spreads', () => {
    const data = { product: { title: 'Book', details: 'Details' } }
    const tracker = trackPayloadUsage(data)
    expect('title' in data.product).toBe(true)
    expect({ ...data.product }).toEqual({ title: 'Book', details: 'Details' })
    expect(tracker.finish()).toMatchObject([{ unread: [] }])
  })

  it('does not invoke getters while inspecting unsupported objects', () => {
    const data = { product: { get title(): string {
      throw new Error('Getter called')
    } } }
    const tracker = trackPayloadUsage(data)
    expect(tracker.finish()).toMatchObject([{ status: 'skipped' }])
  })

  it('keeps unsupported entries visible and unchanged', () => {
    const data = { array: ['one'], nil: null, frozen: Object.freeze({ a: 1 }), reactive: reactive({ a: 1 }) }
    const tracker = trackPayloadUsage(data)
    expect(tracker.finish().every(entry => entry.status === 'skipped')).toBe(true)
    expect(data.array).toEqual(['one'])
    expect(data.frozen.a).toBe(1)
  })

  it('shares read tracking across aliases and preserves object identity', () => {
    const value = { title: 'Book', details: 'Details' }
    const data = { first: value, second: value }
    const tracker = trackPayloadUsage(data)
    expect(data.first).toBe(data.second)
    expect(data.first.title).toBe('Book')
    expect(tracker.finish().map(entry => entry.status === 'tracked' && entry.read)).toEqual([['title'], ['title']])
  })

  it.each([reactive, shallowReactive, readonly, shallowReadonly])('skips tracking when a Vue proxy hides a payload root reference (%#)', (wrap) => {
    const shared = { title: 'Book', details: 'Details' }
    const data = { product: shared, alias: wrap(shared) }
    const tracker = trackPayloadUsage(data)
    expect(data.product).toBe(toRaw(data.alias))
    expect(data.alias.details).toBe('Details')
    expect(tracker.finish()).toMatchObject([
      { key: 'product', status: 'skipped' },
      { key: 'alias', status: 'skipped' },
    ])
  })

  it('reports unknown sizes for cycles without hiding the field', () => {
    const value: Record<string, unknown> = {}
    value.self = value
    const data = { product: { cyclic: value } }
    expect(trackPayloadUsage(data).finish()).toMatchObject([{ unread: [{ key: 'cyclic', bytes: null }] }])
  })
})

it('does not read nested getters when estimating sizes', () => {
  const data = { product: { nested: { get value(): string {
    throw new Error('Getter called')
  } } } }
  expect(trackPayloadUsage(data).finish()).toMatchObject([{ status: 'skipped' }])
})

it('counts writes conservatively and preserves deletion', () => {
  const data: Record<string, Record<string, string>> = { product: { title: 'Book', details: 'Details' } }
  const tracker = trackPayloadUsage(data)
  data.product!.title = 'Changed'
  delete data.product!.details
  expect(tracker.finish()).toMatchObject([{ unread: [] }])
  expect(data.product).toEqual({ title: 'Changed' })
})

it('preserves nested aliases and cycles without reporting indirect reads as unused', () => {
  const shared = { title: 'Book', details: 'Details' }
  const cycle = { self: null as unknown }
  cycle.self = cycle
  const data = { product: shared, basket: { product: shared }, cycle }
  const tracker = trackPayloadUsage(data)
  expect(data.product).toBe(shared)
  expect(data.product).toBe(data.basket.product)
  expect(data.cycle.self).toBe(data.cycle)
  expect(data.basket.product.details).toBe('Details')
  const report = tracker.finish()
  expect(report.find(entry => entry.key === 'product')).toMatchObject({ status: 'skipped' })
  expect(report.find(entry => entry.key === 'cycle')).toMatchObject({ status: 'skipped' })
  expect(data.product).toBe(shared)
  expect(data.cycle.self).toBe(data.cycle)
  expect(Object.getOwnPropertyDescriptor(shared, 'details')).toEqual({
    value: 'Details',
    writable: true,
    enumerable: true,
    configurable: true,
  })
})

it.each([
  ['__v_raw', 'root'],
  ['__v_isRef', 'root'],
  ['__v_raw', 'nested'],
  ['__v_isRef', 'nested'],
])('skips Vue-marker getters without invoking them: %s at %s', (marker, position) => {
  let calls = 0
  const value = Object.defineProperty({}, marker, { get() {
    calls++
    throw new Error('Marker called')
  } })
  const data = { product: position === 'root' ? value : { nested: value } }
  expect(trackPayloadUsage(data).finish()).toMatchObject([{ status: 'skipped' }])
  expect(calls).toBe(0)
})

it('returns unavailable size when a compact shared graph exceeds the estimation budget', () => {
  let value: object = { text: 'Details' }
  for (let index = 0; index < 18; index++)
    value = { left: value, right: value }
  const data = { product: { nested: value } }
  expect(trackPayloadUsage(data).finish()).toMatchObject([{ unread: [{ key: 'nested', bytes: null }] }])
})

it('returns unavailable size for deep values and oversized strings', () => {
  let value: object = {}
  for (let index = 0; index < 1000; index++)
    value = { child: value }
  const data = { product: { deep: value, large: 'x'.repeat(2 ** 20) } }
  expect(trackPayloadUsage(data).finish()).toMatchObject([{ unread: [
    { key: 'deep', bytes: null },
    { key: 'large', bytes: null },
  ] }])
})

it('preserves data descriptors during writes, deletion, and redefinition', () => {
  const data: Record<string, Record<string, string>> = { product: { title: 'Book', details: 'Details', extra: 'Extra' } }
  const tracker = trackPayloadUsage(data)
  data.product!.title = 'Changed'
  delete data.product!.details
  Object.defineProperty(data.product, 'extra', { value: 'Replaced' })
  expect(tracker.finish()).toMatchObject([{ unread: [] }])
  expect(Object.getOwnPropertyDescriptor(data.product, 'title')).toEqual({
    value: 'Changed',
    writable: true,
    enumerable: true,
    configurable: true,
  })
  expect(data.product).toEqual({ title: 'Changed', extra: 'Replaced' })
})

it('preserves inherited writes without changing the payload value', () => {
  const data = { product: { title: 'Book' } }
  const tracker = trackPayloadUsage(data)
  const child = Object.create(data.product)
  child.title = 'Child'
  expect(child.title).toBe('Child')
  expect(data.product.title).toBe('Book')
  expect(tracker.finish()).toMatchObject([{ unread: [] }])
})

it('skips readonly and nonconfigurable properties without changing their descriptors', () => {
  const readonly = Object.defineProperty({}, 'title', { value: 'Book', configurable: true, enumerable: true })
  const fixed = Object.defineProperty({}, 'title', { value: 'Book', writable: true, enumerable: true })
  const before = [readonly, fixed].map(value => Object.getOwnPropertyDescriptor(value, 'title'))
  const tracker = trackPayloadUsage({ readonly, fixed })
  expect(tracker.finish().map(entry => entry.status)).toEqual(['skipped', 'skipped'])
  expect([readonly, fixed].map(value => Object.getOwnPropertyDescriptor(value, 'title'))).toEqual(before)
})

it('preserves sealed writes and rejects frozen writes during and after collection', () => {
  const data = { sealed: { title: 'Book' }, frozen: { title: 'Book' } }
  const tracker = trackPayloadUsage(data)
  Object.seal(data.sealed)
  Object.freeze(data.frozen)
  data.sealed.title = 'Changed'
  expect(data.sealed.title).toBe('Changed')
  expect(() => {
    data.frozen.title = 'Changed'
  }).toThrow(TypeError)
  expect(tracker.finish().every(entry => entry.status === 'tracked')).toBe(true)
  data.sealed.title = 'After'
  expect(data.sealed.title).toBe('After')
  expect(() => {
    data.frozen.title = 'After'
  }).toThrow(TypeError)
  expect(data.frozen.title).toBe('Book')
})

it('skips tracking when the reference scan budget cannot establish root identity', () => {
  let value: object = {}
  for (let index = 0; index < 11000; index++)
    value = { child: value }
  const original = { value }
  const data = { product: original }
  expect(trackPayloadUsage(data).finish()).toMatchObject([{ status: 'skipped' }])
  expect(data.product).toBe(original)
})

it.each(['map value', 'map key', 'set'])('skips roots referenced by %s without changing collection identity', (kind) => {
  const shared = { details: 'Details' }
  const collection = kind === 'set'
    ? new Set([shared])
    : kind === 'map key' ? new Map([[shared, 'item']]) : new Map([['item', shared]])
  const data = { product: shared, basket: { collection } }
  const tracker = trackPayloadUsage(data)
  expect(data.product).toBe(shared)
  expect(data.basket.collection).toBe(collection)
  expect(tracker.finish().find(entry => entry.key === 'product')).toMatchObject({ status: 'skipped' })
  expect(data.product).toBe(shared)
})

it('uses native collection iteration without invoking overridden methods', () => {
  const shared = { details: 'Details' }
  const map = new Map([['item', shared]])
  Object.defineProperty(map, 'entries', { get() {
    throw new Error('Getter called')
  } })
  const data = { product: shared, map }
  expect(trackPayloadUsage(data).finish().every(entry => entry.status === 'skipped')).toBe(true)
  expect(data.product).toBe(shared)
})

it('skips tracking when custom objects can hide root references', () => {
  const shared = { details: 'Details' }
  const hidden = Object.create({})
  hidden.product = shared
  const data = { product: shared, hidden }
  expect(trackPayloadUsage(data).finish().every(entry => entry.status === 'skipped')).toBe(true)
  expect(data.product).toBe(shared)
})

it.each(['__v_raw', '__v_isRef'])('does not invoke inherited array marker getters: %s', (marker) => {
  let calls = 0
  const ancestor = Object.create(Array.prototype)
  Object.defineProperty(ancestor, marker, { get() {
    calls++
    throw new Error('Marker called')
  } })
  const value = Object.setPrototypeOf(['Details'], Object.create(ancestor))
  const data = { product: { nested: value } }
  expect(trackPayloadUsage(data).finish()).toMatchObject([{ status: 'skipped' }])
  expect(calls).toBe(0)
})

it.each(['nested', 'outer'])('skips roots when a %s accessor can hide an alias', (position) => {
  let calls = 0
  const shared = { details: 'Details' }
  const alias = { get product() {
    calls++
    return shared
  } }
  const data = position === 'nested'
    ? { product: shared, basket: alias }
    : Object.defineProperty({ product: shared }, 'alias', Object.getOwnPropertyDescriptor(alias, 'product')!)
  const tracker = trackPayloadUsage(data)
  expect(calls).toBe(0)
  expect(tracker.finish().every(entry => entry.status === 'skipped')).toBe(true)
  expect(data.product).toBe(shared)
  expect(data.product).toBe(alias.product)
  expect(calls).toBe(1)
})

it.each(['outer', 'nested', 'map'])('skips tracking when a %s function can hide a reference', (position) => {
  const shared = { details: 'Details' }
  const getProduct = () => shared
  const hidden = position === 'outer' ? getProduct : position === 'nested' ? { getProduct } : new Map([['getProduct', getProduct]])
  const data = { product: shared, hidden }
  expect(trackPayloadUsage(data).finish().every(entry => entry.status === 'skipped')).toBe(true)
  expect(data.product).toBe(getProduct())
})

it.each(['method', 'getter'])('never executes an inherited toJSON %s while estimating bytes', (kind) => {
  let calls = 0
  const prototype = Object.create(Array.prototype)
  const toJSON = () => {
    calls++
    throw new Error('Serialization called')
  }
  Object.defineProperty(prototype, 'toJSON', kind === 'method' ? { value: toJSON } : { get: toJSON })
  const value = Object.setPrototypeOf(['Details'], prototype)
  expect(trackPayloadUsage({ product: { nested: value } }).finish()).toMatchObject([{ status: 'skipped' }])
  expect(calls).toBe(0)
})

it.each(['readonly', 'nonenumerable', 'symbol'])('preserves every cache alias when one alias is %s', (kind) => {
  const shared = { details: 'Details' }
  const alias = kind === 'symbol' ? Symbol('alias') : 'alias'
  const data = { product: shared } as Record<PropertyKey, typeof shared>
  Object.defineProperty(data, alias, {
    value: shared,
    writable: kind !== 'readonly',
    enumerable: kind !== 'nonenumerable',
    configurable: true,
  })
  const tracker = trackPayloadUsage(data)
  expect(data.product).toBe(data[alias])
  expect(data[alias]!.details).toBe('Details')
  expect(tracker.finish().every(entry => entry.status === 'skipped')).toBe(true)
})

it('never evaluates inherited sparse-array index getters', () => {
  let calls = 0
  const prototype = Object.create(Array.prototype)
  Object.defineProperty(prototype, '0', { get() {
    calls++
    throw new Error('Index getter called')
  } })
  const sparse = Array.from({ length: 1 })
  delete sparse[0]
  Object.setPrototypeOf(sparse, prototype)
  const data = { product: { sparse } }
  const tracker = trackPayloadUsage(data)
  expect(calls).toBe(0)
  expect(tracker.finish()).toMatchObject([{ status: 'skipped' }])
})

it('preserves root aliases inherited by sparse arrays', () => {
  const shared = { details: 'Details' }
  const sparse = Array.from({ length: 1 })
  delete sparse[0]
  Object.setPrototypeOf(sparse, Object.assign(Object.create(Array.prototype), { 0: shared }))
  const data = { product: shared, basket: { sparse } }
  const tracker = trackPayloadUsage(data)
  expect(data.product).toBe(data.basket.sparse[0])
  expect(tracker.finish().every(entry => entry.status === 'skipped')).toBe(true)
})

it('estimates ordinary sparse arrays without changing their holes', () => {
  const sparse = Array.from({ length: 1 })
  delete sparse[0]
  const data = { product: { sparse } }
  const tracker = trackPayloadUsage(data)
  expect(tracker.finish()).toMatchObject([{ unread: [{ key: 'sparse', bytes: 17 }] }])
  expect(0 in data.product.sparse).toBe(false)
})
