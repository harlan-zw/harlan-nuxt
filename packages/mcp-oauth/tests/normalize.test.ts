import { describe, expect, it } from 'vitest'
import { isMcpHostOwnedBy, mcpNameSkeleton, normalizeMcpPath } from '../src/index'

describe('normalizeMcpPath', () => {
  it.each([
    ['/mcp/pro', '/mcp/pro'],
    ['/mcp/pro/', '/mcp/pro'],
    ['//mcp//pro', '/mcp/pro'],
    ['/./mcp/pro', '/mcp/pro'],
    ['/a/../mcp/pro', '/mcp/pro'],
    ['/mcp%2Fpro', '/mcp/pro'],
    ['/mcp/pro;jsessionid=1', '/mcp/pro'],
    ['/mcp/pro/././', '/mcp/pro'],
    ['/mcp/pro?foo=1', '/mcp/pro'],
    ['/mcp/pro#frag', '/mcp/pro'],
    ['/mcp/pro/?a=b', '/mcp/pro'],
    ['/mcp/pro\\', '/mcp/pro'],
    ['/mcp/pro ', '/mcp/pro'],
  ])('folds %s onto %s', (input, expected) => {
    // Every one of these was served by the router as the protected resource
    // while an exact-equality match classified it as "not the resource", so
    // the bearer check was skipped. Reproduced in production with the
    // trailing-slash form.
    expect(normalizeMcpPath(input)).toBe(expected)
  })

  it('strips control characters used to truncate a path', () => {
    expect(normalizeMcpPath('/mcp/pro\u0000.json')).toBe('/mcp/pro.json')
  })

  it('keeps case, because a path is case-sensitive', () => {
    expect(normalizeMcpPath('/MCP/pro')).toBe('/MCP/pro')
  })

  it('does not climb above the root', () => {
    expect(normalizeMcpPath('/../../etc/passwd')).toBe('/etc/passwd')
  })

  it('normalises the root and the empty path to the root', () => {
    expect(normalizeMcpPath('/')).toBe('/')
    expect(normalizeMcpPath('')).toBe('/')
  })

  it('falls back to the raw path on a malformed escape', () => {
    // A bad escape must not skip normalisation; it must not match an endpoint
    // by accident either.
    expect(normalizeMcpPath('/mcp/%zz')).toBe('/mcp/%zz')
  })
})

describe('mcpNameSkeleton', () => {
  it.each([
    'Acme Cloud',
    'acmecloud',
    'Acme-Cloud',
    'Acme.Cloud',
    'Acme_Cloud',
    'ACME  CLOUD',
    'Acme​Cloud',
    'Acme⁠Cloud',
    'Acme‮Cloud',
    'Аcme Cloud'.replace('А', 'A'),
    'Ａｃｍｅ Ｃｌｏｕｄ',
    'Ácme Cloud',
  ])('reduces %j to acmecloud', (input) => {
    expect(mcpNameSkeleton(input)).toBe('acmecloud')
  })

  it('does NOT fold a cross-script homoglyph', () => {
    // Recorded as a known limit rather than implied by an absent case. A
    // Cyrillic a survives NFKD, so `Cl\u0430ude` is not `claude`; catching it
    // needs a confusables table and the unverified marker is the backstop.
    expect(mcpNameSkeleton('Cl\u0430ude')).not.toBe('claude')
  })

  it('keeps digits, so a numeric brand is comparable', () => {
    expect(mcpNameSkeleton('Web 2.0 Tools')).toBe('web20tools')
  })

  it('reduces a punctuation-only name to nothing', () => {
    expect(mcpNameSkeleton('---')).toBe('')
    expect(mcpNameSkeleton('')).toBe('')
  })
})

describe('isMcpHostOwnedBy', () => {
  it('accepts the host itself and its subdomains', () => {
    expect(isMcpHostOwnedBy('claude.ai', ['claude.ai'])).toBe(true)
    expect(isMcpHostOwnedBy('api.claude.ai', ['claude.ai'])).toBe(true)
    expect(isMcpHostOwnedBy('CLAUDE.AI', ['claude.ai'])).toBe(true)
    expect(isMcpHostOwnedBy('claude.ai.', ['claude.ai'])).toBe(true)
  })

  it('owns nothing for a blank root or a hostless client id', () => {
    // A non-special client id such as `urn:foo:bar` parses to an empty
    // hostname, which matched a blank root and read as first-party.
    expect(isMcpHostOwnedBy('', [''])).toBe(false)
    expect(isMcpHostOwnedBy('evil.example', [''])).toBe(false)
    expect(isMcpHostOwnedBy('', ['claude.ai'])).toBe(false)
    expect(isMcpHostOwnedBy('evil.example', ['  '])).toBe(false)
  })

  it('accepts a leading-dot root, the natural wildcard spelling', () => {
    // Written `.claude.ai` this used to match nothing, so ownedHosts was dead
    // config and every first-party client silently read as unverified.
    expect(isMcpHostOwnedBy('claude.ai', ['.claude.ai'])).toBe(true)
    expect(isMcpHostOwnedBy('api.claude.ai', ['.claude.ai'])).toBe(true)
    expect(isMcpHostOwnedBy('evilclaude.ai', ['.claude.ai'])).toBe(false)
  })

  it('refuses a host that merely ends with the same characters', () => {
    // `host.endsWith(root)` is the predicate an adopter writes by hand, and it
    // hands the brand to evilclaude.ai. That is why this ships.
    expect(isMcpHostOwnedBy('evilclaude.ai', ['claude.ai'])).toBe(false)
    expect(isMcpHostOwnedBy('claude.ai.attacker.example', ['claude.ai'])).toBe(false)
    expect(isMcpHostOwnedBy('notclaude.ai', ['claude.ai'])).toBe(false)
  })

  it('owns nothing when the list is empty', () => {
    expect(isMcpHostOwnedBy('claude.ai', [])).toBe(false)
  })
})
