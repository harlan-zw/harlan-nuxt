import { describe, expect, it } from 'vitest'
import { canonicalJson, sha256Hex } from '../src/digest'

describe('canonicalJson', () => {
  it('sorts keys recursively, so key order cannot change the digest input', () => {
    const a = canonicalJson({ seat: 's', state: { query: 'x', brandTerms: ['nuxt seo'] }, questionVersion: 'v1', subject: 'q:x' })
    const b = canonicalJson({ questionVersion: 'v1', subject: 'q:x', state: { brandTerms: ['nuxt seo'], query: 'x' }, seat: 's' })
    expect(b).toBe(a)
  })

  it('drops undefined fields', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it('serializes scalars and null', () => {
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(1.5)).toBe('1.5')
    expect(canonicalJson('x')).toBe('"x"')
  })
})

describe('sha256Hex', () => {
  it('matches a known vector', async () => {
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('gives the same digest for equal objects in different key order', async () => {
    const one = await sha256Hex(canonicalJson({ a: 1, b: { c: 2, d: [3, 4] } }))
    const two = await sha256Hex(canonicalJson({ b: { d: [3, 4], c: 2 }, a: 1 }))
    expect(two).toBe(one)
  })

  it('gives a different digest for different content', async () => {
    const one = await sha256Hex(canonicalJson({ a: 1 }))
    const two = await sha256Hex(canonicalJson({ a: 2 }))
    expect(two).not.toBe(one)
  })
})
