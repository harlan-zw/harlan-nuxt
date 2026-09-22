import { describe, expect, it } from 'vitest'
import { createMcpConsentCacheControl, createMcpConsentFormAction } from '../src/consent'

describe('createMcpConsentFormAction', () => {
  it('allows this server and the callback origin, and nothing else', () => {
    expect(createMcpConsentFormAction('https://chatgpt.com/connector/oauth/x'))
      .toBe('\'self\' https://chatgpt.com')
  })

  it('narrows a path-bearing callback to its origin', () => {
    expect(createMcpConsentFormAction('https://example.com/a/b/c?d=e'))
      .toBe('\'self\' https://example.com')
  })

  it('falls back to the scheme for an opaque-origin callback', () => {
    // A custom scheme has a `null` origin, which CSP would read as the literal
    // string `null` and match nothing, silently breaking the desktop flow.
    expect(createMcpConsentFormAction('cursor://anysphere.cursor-mcp/oauth/callback'))
      .toBe('\'self\' cursor:')
  })

  it('degrades to this server for an unparseable callback', () => {
    // RFC 7591 `redirect_uris` is client-supplied metadata, so a stored
    // malformed callback must degrade to `'self'`, not crash the render.
    expect(createMcpConsentFormAction('not a url'))
      .toBe('\'self\'')
  })
})

describe('createMcpConsentCacheControl', () => {
  it('keeps the page out of every shared cache', () => {
    // The page carries a CSRF secret and names the account a grant will open.
    const value = createMcpConsentCacheControl()

    expect(value).toContain('private')
    expect(value).toContain('no-store')
  })
})
