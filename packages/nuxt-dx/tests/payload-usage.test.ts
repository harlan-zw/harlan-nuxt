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

  it('counts spreads and membership checks conservatively', () => {
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
