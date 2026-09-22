import { describe, expect, it } from 'vitest'
import { grantedMcpScopes } from '../src/scopes'

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

  it('refuses when a required scope was not requested, and says which', () => {
    expect(grantedMcpScopes(['mcp:write'], policy))
      .toEqual({ _tag: 'Err', reason: 'missing_required_scope', missing: ['mcp:read'] })
    expect(grantedMcpScopes([], policy))
      .toEqual({ _tag: 'Err', reason: 'missing_required_scope', missing: ['mcp:read'] })
  })

  it('never grants a scope outside the policy', () => {
    expect(grantedMcpScopes(['mcp:read', 'admin:everything'], policy))
      .toEqual({ _tag: 'Ok', scopes: ['mcp:read'] })
  })

  it('is stable against request order and duplicates', () => {
    // The granted list is stored on the grant, so two clients asking for the
    // same access must produce the same value.
    const a = grantedMcpScopes(['offline_access', 'mcp:write', 'mcp:read'], policy)
    const b = grantedMcpScopes(['mcp:read', 'mcp:read', 'mcp:write', 'offline_access'], policy)

    expect(a).toEqual(b)
    expect(a).toEqual({ _tag: 'Ok', scopes: ['mcp:read', 'mcp:write', 'offline_access'] })
  })

  it('serves a read-only server with no optional scopes', () => {
    const readOnly = { required: ['mcp:read'], optional: [] }

    expect(grantedMcpScopes(['mcp:read', 'mcp:write'], readOnly))
      .toEqual({ _tag: 'Ok', scopes: ['mcp:read'] })
  })
})
