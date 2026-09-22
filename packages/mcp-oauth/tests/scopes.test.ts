import { describe, expect, it } from 'vitest'
import { grantedMcpScopes, mcpRefreshTokenTtl } from '../src/index'

const policy = {
  required: ['mcp:read'],
  optional: ['mcp:write', 'offline_access'],
}

describe('grantedMcpScopes', () => {
  it('grants only what the client asked for', () => {
    // A read-only client handed a write scope holds a credential it can mutate
    // with, and neither it nor the approving user knows that.
    expect(grantedMcpScopes(['mcp:read'], policy)).toEqual({ _tag: 'Ok', scopes: ['mcp:read'] })
  })

  it('grants the optional scopes that were requested', () => {
    expect(grantedMcpScopes(['mcp:read', 'mcp:write'], policy))
      .toEqual({ _tag: 'Ok', scopes: ['mcp:read', 'mcp:write'] })
    expect(grantedMcpScopes(['mcp:read', 'mcp:write', 'offline_access'], policy))
      .toEqual({ _tag: 'Ok', scopes: ['mcp:read', 'mcp:write', 'offline_access'] })
  })

  it('refuses when a required scope was not requested, and names which', () => {
    expect(grantedMcpScopes(['mcp:write'], policy))
      .toEqual({ _tag: 'Err', reason: 'missing_required_scope', missing: ['mcp:read'] })
  })

  it('names only the missing required scopes, not all of them', () => {
    // With a single required scope, a mutant echoing the whole required list
    // is indistinguishable from the correct answer.
    expect(grantedMcpScopes(['mcp:read'], { required: ['mcp:read', 'mcp:admin'], optional: [] }))
      .toEqual({ _tag: 'Err', reason: 'missing_required_scope', missing: ['mcp:admin'] })
  })

  it('never grants a scope outside the policy', () => {
    expect(grantedMcpScopes(['mcp:read', 'admin:everything'], policy))
      .toEqual({ _tag: 'Ok', scopes: ['mcp:read'] })
  })

  it('is stable against request order and duplicates', () => {
    const a = grantedMcpScopes(['offline_access', 'mcp:write', 'mcp:read'], policy)
    const b = grantedMcpScopes(['mcp:read', 'mcp:read', 'mcp:write', 'offline_access'], policy)

    expect(a).toEqual(b)
    expect(a).toEqual({ _tag: 'Ok', scopes: ['mcp:read', 'mcp:write', 'offline_access'] })
  })

  it('emits a scope listed in both halves exactly once', () => {
    // The granted list is stored and compared, so a duplicate makes two
    // grants for the same access look different.
    expect(grantedMcpScopes(['mcp:read'], { required: ['mcp:read'], optional: ['mcp:read'] }))
      .toEqual({ _tag: 'Ok', scopes: ['mcp:read'] })
  })

  it('serves a read-only server with no optional scopes', () => {
    expect(grantedMcpScopes(['mcp:read', 'mcp:write'], { required: ['mcp:read'], optional: [] }))
      .toEqual({ _tag: 'Ok', scopes: ['mcp:read'] })
  })

  it('grants nothing, and refuses nothing, under an empty policy', () => {
    expect(grantedMcpScopes(['mcp:read'], { required: [], optional: [] }))
      .toEqual({ _tag: 'Ok', scopes: [] })
  })
})

describe('mcpRefreshTokenTtl', () => {
  it('withholds a refresh token when offline access was not granted', () => {
    // Intersecting offline_access into the granted scopes changes nothing on
    // its own: a provider mints a refresh token whenever its TTL is non-zero,
    // without consulting scope. So a user who declined offline access still
    // issued a 30-day credential and the consent page's promise was false.
    expect(mcpRefreshTokenTtl(['mcp:read'], { ttl: 2_592_000 })).toBe(0)
  })

  it('allows the configured lifetime once offline access is granted', () => {
    expect(mcpRefreshTokenTtl(['mcp:read', 'offline_access'], { ttl: 2_592_000 })).toBe(2_592_000)
  })

  it('honours a server that names the scope differently', () => {
    expect(mcpRefreshTokenTtl(['custom:offline'], { ttl: 60, offlineAccessScope: 'custom:offline' }))
      .toBe(60)
  })
})
