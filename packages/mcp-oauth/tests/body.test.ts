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

  it.each(['Infinity', '1e999', '2e6', '0x200000', '5, 2000000', '2000000abc', '1_000_000', '-5', 'abc'])(
    'refuses a declaration of %j rather than reading it as small',
    (value) => {
      // Every one of these passed the old Number.isFinite guard as "under the
      // limit". `5, 2000000` is what a header getter yields when it joins
      // duplicate Content-Length values, which some proxies emit.
      expect(exceedsMcpBodyLimit(value)).toBe(true)
    },
  )

  it('honours a caller-supplied cap', () => {
    expect(exceedsMcpBodyLimit('2048', 1024)).toBe(true)
    expect(exceedsMcpBodyLimit('512', 1024)).toBe(false)
  })
})
