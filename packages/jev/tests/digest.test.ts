import { describe, expect, it } from 'vitest'
import { canonicalJson, digestKey } from '../src/digest'

describe('canonicalJson', () => {
  it('sorts keys recursively, so key order cannot change the digest input', () => {
    const a = canonicalJson({ seat: 's', state: { query: 'x', brandTerms: ['nuxt seo'] }, questionVersion: 'v1', subject: 'q:x' })
    const b = canonicalJson({ questionVersion: 'v1', subject: 'q:x', state: { brandTerms: ['nuxt seo'], query: 'x' }, seat: 's' })
    expect(b).toBe(a)
  })

  it('drops undefined fields', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it('sorts keys by code unit, never by locale, so digests are runtime-independent', () => {
    expect(canonicalJson({ Z: 1, a: 2, é: 3 })).toBe('{"Z":1,"a":2,"é":3}')
  })

  it('serializes scalars and null', () => {
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(1.5)).toBe('1.5')
    expect(canonicalJson('x')).toBe('"x"')
  })
})

describe('digestKey', () => {
  it('is deterministic: the same input gives the same digest on every call', () => {
    const input = canonicalJson({ a: 1, b: { c: 2, d: [3, 4] } })
    expect(digestKey(input)).toBe(digestKey(input))
  })

  it('gives the same digest for equal objects in different key order', () => {
    const one = digestKey(canonicalJson({ a: 1, b: { c: 2, d: [3, 4] } }))
    const two = digestKey(canonicalJson({ b: { d: [3, 4], c: 2 }, a: 1 }))
    expect(two).toBe(one)
  })

  it('gives a different digest for different content', () => {
    const one = digestKey(canonicalJson({ a: 1 }))
    const two = digestKey(canonicalJson({ a: 2 }))
    expect(two).not.toBe(one)
  })
})
