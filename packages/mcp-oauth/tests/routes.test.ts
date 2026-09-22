import type { McpOAuthEndpoints } from '../src/endpoints'
import { describe, expect, it } from 'vitest'
import { matchMcpOAuthRoute } from '../src/routes'

/** A deployment split across Workers, nesting under a prefix its route table binds. */
const nested: McpOAuthEndpoints = {
  authorize: '/pro/oauth/authorize',
  token: '/pro/oauth/token',
  register: '/pro/oauth/register',
  resource: '/mcp/pro',
}

/** A single-Worker deployment owning the apex. */
const apex: McpOAuthEndpoints = {
  authorize: '/oauth/authorize',
  token: '/oauth/token',
  register: '/oauth/register',
  resource: '/mcp',
}

describe('matchMcpOAuthRoute', () => {
  it('classifies the protocol endpoints of a nested deployment', () => {
    expect(matchMcpOAuthRoute('/pro/oauth/authorize', 'GET', nested)).toEqual({ _tag: 'OAuthProvider' })
    expect(matchMcpOAuthRoute('/pro/oauth/token', 'POST', nested)).toEqual({ _tag: 'OAuthProvider' })
    expect(matchMcpOAuthRoute('/pro/oauth/register', 'POST', nested)).toEqual({ _tag: 'OAuthProvider' })
    expect(matchMcpOAuthRoute('/mcp/pro', 'POST', nested)).toEqual({ _tag: 'ProtectedMcp' })
  })

  it('classifies the same endpoints at the apex', () => {
    // The paths are configuration precisely because these two shapes coexist.
    expect(matchMcpOAuthRoute('/oauth/authorize', 'GET', apex)).toEqual({ _tag: 'OAuthProvider' })
    expect(matchMcpOAuthRoute('/mcp', 'POST', apex)).toEqual({ _tag: 'ProtectedMcp' })
    // One deployment's path is not the other's.
    expect(matchMcpOAuthRoute('/pro/oauth/authorize', 'GET', apex)).toEqual({ _tag: 'Ignore' })
  })

  it('answers both well-known documents, with and without the resource suffix', () => {
    expect(matchMcpOAuthRoute('/.well-known/oauth-authorization-server', 'GET', nested))
      .toEqual({ _tag: 'OAuthProvider' })
    // RFC 8414 allows the resource path appended to the prefix, which is what
    // a real client requests, so equality alone would 404 the discovery call.
    expect(matchMcpOAuthRoute('/.well-known/oauth-protected-resource/mcp/pro', 'GET', nested))
      .toEqual({ _tag: 'OAuthProvider' })
  })

  it('leaves a preflight to the provider rather than the bearer challenge', () => {
    // A preflight carries no credential by definition. Classifying it as the
    // protected resource makes the 401 fire and the real request never happen.
    expect(matchMcpOAuthRoute('/mcp/pro', 'OPTIONS', nested)).toEqual({ _tag: 'ProtectedMcp' })
  })

  it('ignores a method the endpoint does not serve', () => {
    expect(matchMcpOAuthRoute('/pro/oauth/token', 'GET', nested)).toEqual({ _tag: 'Ignore' })
    expect(matchMcpOAuthRoute('/pro/oauth/register', 'GET', nested)).toEqual({ _tag: 'Ignore' })
    expect(matchMcpOAuthRoute('/mcp/pro', 'GET', nested)).toEqual({ _tag: 'Ignore' })
    expect(matchMcpOAuthRoute('/.well-known/oauth-authorization-server', 'POST', nested))
      .toEqual({ _tag: 'Ignore' })
  })

  it('accepts a lowercase method', () => {
    expect(matchMcpOAuthRoute('/mcp/pro', 'post', nested)).toEqual({ _tag: 'ProtectedMcp' })
  })

  it('ignores the registration path when the server offers no registration', () => {
    const closed = { ...nested, register: null }

    expect(matchMcpOAuthRoute('/pro/oauth/register', 'POST', closed)).toEqual({ _tag: 'Ignore' })
    // A `null` register must not accidentally match some other path.
    expect(matchMcpOAuthRoute('', 'POST', closed)).toEqual({ _tag: 'Ignore' })
  })

  it('leaves every unrelated path alone', () => {
    expect(matchMcpOAuthRoute('/api/pro/sites', 'POST', nested)).toEqual({ _tag: 'Ignore' })
    expect(matchMcpOAuthRoute('/pro/dashboard', 'GET', nested)).toEqual({ _tag: 'Ignore' })
    // A prefix of an endpoint is not the endpoint.
    expect(matchMcpOAuthRoute('/mcp/pro/extra', 'POST', nested)).toEqual({ _tag: 'Ignore' })
  })
})
