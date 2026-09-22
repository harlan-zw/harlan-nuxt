import type { McpOAuthEndpoints } from '../src/endpoints'
import { describe, expect, it } from 'vitest'
import { resolveMcpOAuthIdentity } from '../src/identity'

const endpoints: McpOAuthEndpoints = {
  authorize: '/pro/oauth/authorize',
  token: '/pro/oauth/token',
  register: '/pro/oauth/register',
  resource: '/mcp/pro',
}

describe('resolveMcpOAuthIdentity', () => {
  it('derives every identifier from the request origin', () => {
    // A staging deploy must advertise itself. Hardcoded production literals
    // make every preview flow unfinishable, because the identifiers a client
    // is handed name a server it is not talking to.
    expect(resolveMcpOAuthIdentity('https://staging.example.com/mcp/pro', endpoints)).toEqual({
      resource: 'https://staging.example.com/mcp/pro',
      authorizationServer: 'https://staging.example.com',
      resourceMetadataUrl: 'https://staging.example.com/.well-known/oauth-protected-resource/mcp/pro',
    })
  })

  it('prefers a configured origin, for a proxy whose forwarded host is untrusted', () => {
    const identity = resolveMcpOAuthIdentity(
      'http://10.0.0.4:8787/mcp/pro',
      endpoints,
      'https://example.com',
    )

    expect(identity.authorizationServer).toBe('https://example.com')
    expect(identity.resource).toBe('https://example.com/mcp/pro')
  })

  it('discards a configured origin that is blank or unparseable', () => {
    // Falling back to the request beats advertising a broken identifier.
    for (const configured of ['', '   ', 'not a url']) {
      expect(resolveMcpOAuthIdentity('https://real.example.com/x', endpoints, configured).authorizationServer)
        .toBe('https://real.example.com')
    }
  })

  it('takes only the origin of a configured value, ignoring its path', () => {
    expect(resolveMcpOAuthIdentity('https://real.example.com/x', endpoints, 'https://example.com/ignored/path').resource)
      .toBe('https://example.com/mcp/pro')
  })

  it('accepts a URL as well as a string', () => {
    expect(resolveMcpOAuthIdentity(new URL('https://example.com/mcp/pro'), endpoints).authorizationServer)
      .toBe('https://example.com')
  })
})
