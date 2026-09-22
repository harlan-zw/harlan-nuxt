import { describe, expect, it } from 'vitest'
import { createMcpCspNonce, createMcpCsrfToken, createMcpRandomToken, verifyMcpCsrfToken } from '../src/csrf'

describe('createMcpRandomToken', () => {
  it('is url-safe and unpadded, so it survives a cookie and a CSP nonce', () => {
    const token = createMcpRandomToken(() => new Uint8Array([251, 255, 254, 0]))

    expect(token).toBe('-__-AA')
    expect(token).not.toMatch(/[+/=]/)
  })

  it('mints a different value each call', () => {
    expect(createMcpCsrfToken()).not.toBe(createMcpCspNonce())
  })
})

describe('verifyMcpCsrfToken', () => {
  it('accepts a matching double submit', () => {
    const token = createMcpCsrfToken()

    expect(verifyMcpCsrfToken(token, token)).toBe(true)
  })

  it('refuses a mismatch, a length change, and a missing half', () => {
    const token = createMcpCsrfToken()

    expect(verifyMcpCsrfToken(token, createMcpCsrfToken())).toBe(false)
    expect(verifyMcpCsrfToken(token, token.slice(0, -1))).toBe(false)
    expect(verifyMcpCsrfToken(token, `${token}x`)).toBe(false)
    expect(verifyMcpCsrfToken(undefined, token)).toBe(false)
    expect(verifyMcpCsrfToken(token, undefined)).toBe(false)
    // Two absent halves must not read as agreement.
    expect(verifyMcpCsrfToken(undefined, undefined)).toBe(false)
    expect(verifyMcpCsrfToken('', '')).toBe(false)
  })

  it('refuses a value that differs only in the last character', () => {
    // The comparison has no early return. This is the case a prefix-matching
    // implementation gets wrong.
    expect(verifyMcpCsrfToken('abcdef', 'abcdeg')).toBe(false)
  })
})
