import { describe, expect, it } from 'vitest'
import { reactive, ref, shallowRef } from 'vue'
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
  expect(trackPayloadUsage(data).finish()).toMatchObject([{ unread: [{ key: 'nested', bytes: null }] }])
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
  expect(tracker.finish()[0]).toMatchObject({ read: ['details'], unread: [{ key: 'title' }] })
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
  expect(trackPayloadUsage(data).finish()).toMatchObject([position === 'root'
    ? { status: 'skipped' }
    : { unread: [{ key: 'nested', bytes: null }] }])
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
  for (let index = 0; index < 10000; index++)
    value = { child: value }
  const data = { product: { deep: value, large: 'x'.repeat(2 ** 20) } }
  expect(trackPayloadUsage(data).finish()).toMatchObject([{ unread: [
    { key: 'deep', bytes: null },
    { key: 'large', bytes: null },
  ] }])
})

it('restores data descriptors while preserving writes, deletion, and redefinition', () => {
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

it.each([Object.freeze, Object.seal])('finishes collection after descriptors become nonconfigurable', (lock) => {
  const data = { product: { title: 'Book' } }
  const tracker = trackPayloadUsage(data)
  lock(data.product)
  expect(tracker.finish()).toMatchObject([{ unread: [{ key: 'title' }] }])
  expect(() => {
    data.product.title = 'Changed'
  }).toThrow(TypeError)
  expect(data.product.title).toBe('Book')
})
