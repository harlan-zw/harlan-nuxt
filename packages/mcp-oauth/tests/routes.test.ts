import type { McpOAuthEndpoints } from '../src/index'
import { describe, expect, it } from 'vitest'
import { matchMcpOAuthRoute } from '../src/index'

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

describe('matchMcpOAuthRoute path normalisation', () => {
  it.each([
    '/mcp/pro',
    '/mcp/pro/',
    '//mcp//pro',
    '/./mcp/pro',
    '/a/../mcp/pro',
    '/mcp%2Fpro',
    '/mcp/pro;x=1',
  ])('classifies %s as the protected resource', (path) => {
    // `/mcp/pro/` was an authentication bypass in production: it classified as
    // Ignore, the caller skipped the bearer check, and the router folded the
    // trailing slash and served the request off the MCP handler anyway.
    expect(matchMcpOAuthRoute(path, 'POST', nested)).toEqual({ _tag: 'ProtectedMcp' })
  })

  it('normalises the configured endpoint too, so a trailing slash in config is harmless', () => {
    expect(matchMcpOAuthRoute('/mcp/pro', 'POST', { ...nested, resource: '/mcp/pro/' }))
      .toEqual({ _tag: 'ProtectedMcp' })
  })

  it('still ignores a genuinely different path', () => {
    expect(matchMcpOAuthRoute('/mcp/pro/extra', 'POST', nested)).toEqual({ _tag: 'Ignore' })
    expect(matchMcpOAuthRoute('/mcp', 'POST', nested)).toEqual({ _tag: 'Ignore' })
    expect(matchMcpOAuthRoute('/api/pro/sites', 'POST', nested)).toEqual({ _tag: 'Ignore' })
  })

  it('keeps case, so a case variant is the router problem it is', () => {
    expect(matchMcpOAuthRoute('/MCP/pro', 'POST', nested)).toEqual({ _tag: 'Ignore' })
  })
})

describe('matchMcpOAuthRoute endpoints', () => {
  it('classifies the protocol endpoints of a nested deployment', () => {
    expect(matchMcpOAuthRoute('/pro/oauth/authorize', 'GET', nested)).toEqual({ _tag: 'OAuthProvider' })
    expect(matchMcpOAuthRoute('/pro/oauth/token', 'POST', nested)).toEqual({ _tag: 'OAuthProvider' })
    expect(matchMcpOAuthRoute('/pro/oauth/register', 'POST', nested)).toEqual({ _tag: 'OAuthProvider' })
  })

  it('classifies the same endpoints at the apex', () => {
    expect(matchMcpOAuthRoute('/oauth/authorize', 'GET', apex)).toEqual({ _tag: 'OAuthProvider' })
    expect(matchMcpOAuthRoute('/mcp', 'POST', apex)).toEqual({ _tag: 'ProtectedMcp' })
    expect(matchMcpOAuthRoute('/pro/oauth/authorize', 'GET', apex)).toEqual({ _tag: 'Ignore' })
  })

  it.each([
    ['/mcp/pro', 'DELETE', 'ProtectedMcp'],
    ['/mcp/pro', 'OPTIONS', 'ProtectedMcp'],
    ['/mcp/pro', 'GET', 'ProtectedMcp'],
    ['/pro/oauth/authorize', 'POST', 'OAuthProvider'],
    ['/pro/oauth/authorize', 'OPTIONS', 'OAuthProvider'],
    ['/pro/oauth/token', 'OPTIONS', 'OAuthProvider'],
    ['/pro/oauth/register', 'OPTIONS', 'OAuthProvider'],
  ])('serves %s %s', (path, method, tag) => {
    // Each of these is a live break if its method is dropped from the allow
    // list: DELETE is MCP session teardown, OPTIONS is the CORS preflight a
    // browser-hosted client sends before every call, and GET is where MCP
    // Streamable HTTP opens the server-to-client SSE stream. A server that
    // serves that GET and does not classify it streams to an unauthenticated
    // caller; one that answers 405 pays only a bearer check on a dead method.
    expect(matchMcpOAuthRoute(path, method, nested)).toEqual({ _tag: tag })
  })

  it.each([
    ['/pro/oauth/token', 'GET'],
    ['/pro/oauth/register', 'GET'],
    ['/mcp/pro', 'PUT'],
    ['/pro/oauth/authorize', 'DELETE'],
  ])('ignores %s %s, which the endpoint does not serve', (path, method) => {
    expect(matchMcpOAuthRoute(path, method, nested)).toEqual({ _tag: 'Ignore' })
  })

  it('accepts a lowercase method', () => {
    expect(matchMcpOAuthRoute('/mcp/pro', 'post', nested)).toEqual({ _tag: 'ProtectedMcp' })
  })

  it('ignores the registration path when the server offers no registration', () => {
    const closed = { ...nested, register: null }

    expect(matchMcpOAuthRoute('/pro/oauth/register', 'POST', closed)).toEqual({ _tag: 'Ignore' })
    // The token endpoint is unaffected by a null register.
    expect(matchMcpOAuthRoute('/pro/oauth/token', 'POST', closed)).toEqual({ _tag: 'OAuthProvider' })
  })

  it('does not let an empty configured path swallow the root', () => {
    const broken = { ...nested, register: '' }

    expect(matchMcpOAuthRoute('/', 'POST', broken)).toEqual({ _tag: 'OAuthProvider' })
    expect(matchMcpOAuthRoute('/anything', 'POST', broken)).toEqual({ _tag: 'Ignore' })
  })
})

describe('matchMcpOAuthRoute discovery', () => {
  it('serves protected-resource metadata at the root and with the resource appended', () => {
    // RFC 9728 §3.1 appends the resource path, which is the form a real client
    // requests, so equality alone would 404 the discovery call.
    expect(matchMcpOAuthRoute('/.well-known/oauth-protected-resource', 'GET', nested))
      .toEqual({ _tag: 'OAuthProvider' })
    expect(matchMcpOAuthRoute('/.well-known/oauth-protected-resource/mcp/pro', 'GET', nested))
      .toEqual({ _tag: 'OAuthProvider' })
  })

  it('serves authorization-server metadata only at the exact root path', () => {
    // RFC 8414 §3 inserts the well-known segment before the ISSUER's path, and
    // resolveMcpOAuthIdentity produces a path-less issuer, so the root form is
    // the only correct URL. The provider serves only that, so routing the
    // suffixed form to it would yield a text/plain 404.
    expect(matchMcpOAuthRoute('/.well-known/oauth-authorization-server', 'GET', nested))
      .toEqual({ _tag: 'OAuthProvider' })
    expect(matchMcpOAuthRoute('/.well-known/oauth-authorization-server/mcp/pro', 'GET', nested))
      .toEqual({ _tag: 'WellKnownNotFound' })
  })

  it('answers an OIDC discovery probe as a definitive not-found', () => {
    // Real MCP clients probe this. Left unclassified it reaches the app's HTML
    // 404, which a client parsing JSON reports as an invalid OAuth response
    // rather than "no OIDC here".
    expect(matchMcpOAuthRoute('/.well-known/openid-configuration', 'GET', nested))
      .toEqual({ _tag: 'WellKnownNotFound' })
    expect(matchMcpOAuthRoute('/.well-known/openid-configuration/mcp/pro', 'GET', nested))
      .toEqual({ _tag: 'WellKnownNotFound' })
  })

  it('does not hand a prefix sibling to the provider', () => {
    // Without the `/` in the prefix match, an attacker-chosen sibling path was
    // classified as discovery.
    expect(matchMcpOAuthRoute('/.well-known/oauth-protected-resource-evil', 'GET', nested))
      .toEqual({ _tag: 'Ignore' })
    expect(matchMcpOAuthRoute('/.well-known/oauth-authorization-server-evil', 'GET', nested))
      .toEqual({ _tag: 'Ignore' })
  })

  it('answers a HEAD probe as well as a GET', () => {
    expect(matchMcpOAuthRoute('/.well-known/oauth-protected-resource', 'HEAD', nested))
      .toEqual({ _tag: 'OAuthProvider' })
  })

  it('ignores a write method on a discovery path', () => {
    expect(matchMcpOAuthRoute('/.well-known/oauth-authorization-server', 'POST', nested))
      .toEqual({ _tag: 'Ignore' })
  })
})
