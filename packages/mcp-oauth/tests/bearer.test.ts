import { describe, expect, it } from 'vitest'
import { createMcpBearerChallenge, mcpBearerErrorStatus, readBearerToken } from '../src/index'

describe('readBearerToken', () => {
  it.each(['Bearer abc', 'bearer abc', 'BEARER abc'])('reads %s case-insensitively', (header) => {
    expect(readBearerToken(header)).toBe('abc')
  })

  it('ignores another scheme and an absent header', () => {
    expect(readBearerToken('Basic abc')).toBeNull()
    expect(readBearerToken(null)).toBeNull()
    expect(readBearerToken(undefined)).toBeNull()
    expect(readBearerToken('')).toBeNull()
  })

  it('treats an empty credential as absent', () => {
    expect(readBearerToken('Bearer')).toBeNull()
    expect(readBearerToken('Bearer    ')).toBeNull()
  })

  it('preserves an interior space rather than truncating to a valid-looking prefix', () => {
    // A mutant using rest[0] would hand the validator 'a' instead of 'a b',
    // which is a shorter token that could collide with something real.
    expect(readBearerToken('Bearer a b')).toBe('a b')
  })
})

describe('createMcpBearerChallenge', () => {
  it('carries the resource_metadata pointer an MCP client triggers on', () => {
    expect(createMcpBearerChallenge({
      resourceMetadataUrl: 'https://example.com/.well-known/oauth-protected-resource/mcp',
      error: 'invalid_token',
    })).toBe(
      'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource/mcp", error="invalid_token"',
    )
  })

  it('omits the error for a request that carried no credential', () => {
    // RFC 6750 §3: a bare challenge should not name an error there, and some
    // clients treat error="invalid_token" on a missing header as a hard fail
    // rather than an invitation to authenticate.
    expect(createMcpBearerChallenge({ resourceMetadataUrl: 'https://example.com/rm' }))
      .toBe('Bearer resource_metadata="https://example.com/rm"')
  })

  it('names the scope a caller is missing, in a fixed position', () => {
    expect(createMcpBearerChallenge({
      resourceMetadataUrl: 'https://example.com/rm',
      error: 'insufficient_scope',
      scope: 'mcp:write',
    })).toBe('Bearer resource_metadata="https://example.com/rm", error="insufficient_scope", scope="mcp:write"')
  })

  it('cannot be made to inject an extra auth-param through the metadata url', () => {
    // A `"` is a legal host character, so a poisoned Host header reached this
    // interpolation and closed the quoted string early.
    const challenge = createMcpBearerChallenge({
      resourceMetadataUrl: 'https://a",error="insufficient_scope",z="b.com/rm',
      error: 'invalid_token',
    })

    expect(challenge).toBe(
      'Bearer resource_metadata="https://a\\",error=\\"insufficient_scope\\",z=\\"b.com/rm", error="invalid_token"',
    )
    // Exactly one unescaped error parameter.
    expect(challenge.match(/(^|[^\\])error="/g)).toHaveLength(1)
  })

  it('cannot be made to split the header through the scope', () => {
    const challenge = createMcpBearerChallenge({
      resourceMetadataUrl: 'https://example.com/rm',
      error: 'insufficient_scope',
      scope: 'mcp:read\r\nX-Injected: 1',
    })

    expect(challenge).not.toContain('\r')
    expect(challenge).not.toContain('\n')
  })
})

describe('mcpBearerErrorStatus', () => {
  it('distinguishes unauthenticated from unauthorized', () => {
    // 401 invites the client to authenticate; 403 tells it not to bother with
    // the same grant.
    expect(mcpBearerErrorStatus('invalid_token')).toBe(401)
    expect(mcpBearerErrorStatus('insufficient_scope')).toBe(403)
    expect(mcpBearerErrorStatus('invalid_request')).toBe(400)
    expect(mcpBearerErrorStatus(undefined)).toBe(401)
  })
})
