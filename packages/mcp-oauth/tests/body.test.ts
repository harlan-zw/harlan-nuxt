import { describe, expect, it } from 'vitest'
import { exceedsMcpBodyLimit, MCP_BODY_LIMIT_BYTES } from '../src/index'

describe('exceedsMcpBodyLimit', () => {
  it('caps at one mebibyte', () => {
    // Spelled literally: asserting only against the constant leaves the cap
    // free to change to 1 byte or 1 GiB with the suite still green.
    expect(MCP_BODY_LIMIT_BYTES).toBe(1_048_576)
    expect(exceedsMcpBodyLimit('1048577')).toBe(true)
    expect(exceedsMcpBodyLimit('1048576')).toBe(false)
  })

  it('passes a request that declares nothing', () => {
    // Fail-open is deliberate here: an absent length is not evidence of a
    // large body, and the runtime's own limit is still behind this check.
    expect(exceedsMcpBodyLimit(null)).toBe(false)
    expect(exceedsMcpBodyLimit(undefined)).toBe(false)
    expect(exceedsMcpBodyLimit('')).toBe(false)
    expect(exceedsMcpBodyLimit('   ')).toBe(false)
  })

  it.each(['Infinity', '1e999', '2000000abc', '1_000_000', '-5', '+5', 'abc'])(
    'refuses an unparseable declaration of %j rather than reading it as small',
    (value) => {
      // `Infinity` and `1e999` overflow, the rest are NaN, and every one
      // passed the old Number.isFinite guard as "under the limit".
      expect(exceedsMcpBodyLimit(value)).toBe(true)
    },
  )

  it('refuses conflicting duplicate declarations', () => {
    // A header getter joins duplicate Content-Length values with ', '. Two
    // different values are a request smuggling shape, not a small body.
    expect(exceedsMcpBodyLimit('5, 2000000')).toBe(true)
    expect(exceedsMcpBodyLimit('5, 6')).toBe(true)
  })

  it('accepts identical duplicate declarations', () => {
    // RFC 9110 §8.6 lets a recipient collapse these, and undici and Workers
    // both produce the joined form, so refusing it 413s a valid small request.
    expect(exceedsMcpBodyLimit('5, 5')).toBe(false)
    expect(exceedsMcpBodyLimit('5, 5, 5')).toBe(false)
  })

  it('accepts a padded or zero-prefixed decimal', () => {
    expect(exceedsMcpBodyLimit(' 5 ')).toBe(false)
    expect(exceedsMcpBodyLimit('0005')).toBe(false)
  })

  it('honours a caller-supplied cap', () => {
    expect(exceedsMcpBodyLimit('2048', 1024)).toBe(true)
    expect(exceedsMcpBodyLimit('512', 1024)).toBe(false)
  })
})
