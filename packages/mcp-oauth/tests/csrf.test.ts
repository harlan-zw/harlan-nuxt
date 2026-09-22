import { describe, expect, it } from 'vitest'
import { createMcpConsentSecrets, createMcpRandomToken, verifyMcpCsrfToken } from '../src/index'

describe('createMcpRandomToken', () => {
  it('is url-safe and unpadded, so it survives a cookie and a CSP nonce', () => {
    const token = createMcpRandomToken(() => new Uint8Array([251, 255, 254, 0]))

    expect(token).toBe('-__-AA')
  })

  it('spends all 32 bytes of entropy', () => {
    // Without this the default could shrink to 4 bytes and every other
    // assertion in the file would still pass.
    expect(createMcpRandomToken()).toMatch(/^[\w-]{43}$/)
  })

  it('emits nothing for no bytes', () => {
    expect(createMcpRandomToken(() => new Uint8Array([]))).toBe('')
  })

  it('needs no padding stripped for a 3-byte input', () => {
    expect(createMcpRandomToken(() => new Uint8Array([255, 255, 255]))).toBe('____')
  })
})

describe('createMcpConsentSecrets', () => {
  it('mints the CSRF token and the CSP nonce as different values', () => {
    // One function returning both is what makes reuse unrepresentable. Two
    // separately-named functions could not: they were aliases of each other,
    // so a caller could compute one value and print the CSRF secret into the
    // page as the nonce.
    const secrets = createMcpConsentSecrets()

    expect(secrets.csrfToken).not.toBe(secrets.cspNonce)
    expect(secrets.csrfToken).toMatch(/^[\w-]{43}$/)
    expect(secrets.cspNonce).toMatch(/^[\w-]{43}$/)
  })
})

describe('verifyMcpCsrfToken', () => {
  it('accepts a matching double submit', () => {
    const token = createMcpRandomToken()

    expect(verifyMcpCsrfToken(token, token)).toBe(true)
  })

  it.each([
    ['a different token', createMcpRandomToken()],
    ['a truncated token', 'short'],
  ])('refuses %s', (_label, submitted) => {
    expect(verifyMcpCsrfToken(createMcpRandomToken(), submitted)).toBe(false)
  })

  it('refuses a missing half, and two missing halves', () => {
    const token = createMcpRandomToken()

    expect(verifyMcpCsrfToken(undefined, token)).toBe(false)
    expect(verifyMcpCsrfToken(token, undefined)).toBe(false)
    expect(verifyMcpCsrfToken(undefined, undefined)).toBe(false)
    expect(verifyMcpCsrfToken('', '')).toBe(false)
  })

  it('refuses a value that differs only in the last character', () => {
    expect(verifyMcpCsrfToken('abcdef', 'abcdeg')).toBe(false)
  })

  it.each([
    ['numbers', 1, 2],
    ['objects', { a: 1 }, { b: 2 }],
    ['booleans', true, true],
    ['dates', new Date(), new Date(0)],
  ])('refuses two mismatched %s rather than reporting agreement', (_label, cookie, submitted) => {
    // These all returned TRUE before the typeof guard: `(1).length` is
    // undefined, so the length check passed and the loop body never ran.
    expect(verifyMcpCsrfToken(cookie, submitted)).toBe(false)
  })

  it('refuses an array rather than throwing', () => {
    expect(verifyMcpCsrfToken(['a'], ['b'])).toBe(false)
  })

  // The constant-time property is NOT asserted here: timing is not unit
  // testable. The implementation compares every character with no early
  // return; only the fixed token length is observable, and that is why
  // createMcpRandomToken is fixed-width.
})
