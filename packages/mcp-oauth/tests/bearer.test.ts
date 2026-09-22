import { describe, expect, it } from 'vitest'
import { createMcpBearerChallenge, mcpBearerErrorStatus, readBearerToken } from '../src/bearer'

describe('readBearerToken', () => {
  it('reads a bearer token case-insensitively', () => {
    expect(readBearerToken('Bearer abc')).toBe('abc')
    expect(readBearerToken('bearer abc')).toBe('abc')
    expect(readBearerToken('BEARER abc')).toBe('abc')
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
})

describe('createMcpBearerChallenge', () => {
  it('carries the resource_metadata pointer an MCP client triggers on', () => {
    const challenge = createMcpBearerChallenge({
      resourceMetadataUrl: 'https://example.com/.well-known/oauth-protected-resource/mcp',
      error: 'invalid_token',
    })

    expect(challenge).toBe(
      'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource/mcp", error="invalid_token"',
    )
  })

  it('names the scope a caller is missing', () => {
    const challenge = createMcpBearerChallenge({
      resourceMetadataUrl: 'https://example.com/rm',
      error: 'insufficient_scope',
      scope: 'mcp:write',
    })

    expect(challenge).toContain('scope="mcp:write"')
  })
})

describe('mcpBearerErrorStatus', () => {
  it('distinguishes unauthenticated from unauthorized', () => {
    // 401 invites the client to authenticate; 403 tells it not to bother with
    // the same grant. A server that answers 403 to a missing token leaves a
    // connector with nothing to start the OAuth flow on.
    expect(mcpBearerErrorStatus('invalid_token')).toBe(401)
    expect(mcpBearerErrorStatus('insufficient_scope')).toBe(403)
    expect(mcpBearerErrorStatus('invalid_request')).toBe(400)
  })
})
