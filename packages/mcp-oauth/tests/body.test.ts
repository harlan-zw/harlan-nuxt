import { describe, expect, it } from 'vitest'
import { exceedsMcpBodyLimit, MCP_BODY_LIMIT_BYTES } from '../src/body'

describe('exceedsMcpBodyLimit', () => {
  it('refuses a declared body over the cap and allows one at it', () => {
    expect(exceedsMcpBodyLimit(String(MCP_BODY_LIMIT_BYTES + 1))).toBe(true)
    expect(exceedsMcpBodyLimit(String(MCP_BODY_LIMIT_BYTES))).toBe(false)
  })

  it('passes a request that declares nothing parseable', () => {
    // Fail-open is deliberate. An absent or junk `content-length` is not
    // evidence of an oversized body, and the runtime's own limit still holds.
    for (const value of [null, undefined, '', 'abc']) {
      expect(exceedsMcpBodyLimit(value)).toBe(false)
    }
  })

  it('honours a caller-supplied cap', () => {
    expect(exceedsMcpBodyLimit('2048', 1024)).toBe(true)
    expect(exceedsMcpBodyLimit('512', 1024)).toBe(false)
  })
})
