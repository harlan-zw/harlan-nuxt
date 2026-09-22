import { describe, expect, it } from 'vitest'
import { createMcpConsentCacheControl, createMcpConsentFormAction } from '../src/index'

describe('createMcpConsentFormAction', () => {
  it('allows this server and the callback origin, and nothing else', () => {
    expect(createMcpConsentFormAction('https://chatgpt.com/connector/oauth/x'))
      .toEqual({ _tag: 'Ok', formAction: '\'self\' https://chatgpt.com' })
  })

  it('narrows a path-bearing callback to its origin', () => {
    expect(createMcpConsentFormAction('https://example.com/a/b/c?d=e'))
      .toEqual({ _tag: 'Ok', formAction: '\'self\' https://example.com' })
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///etc/passwd',
    'foo://attacker.example',
  ])('refuses to widen form-action for %s', (uri) => {
    // The earlier version emitted the scheme for ANY non-special URL, so a
    // registrant could pick `javascript:` and make every javascript: target a
    // legal form destination, removing the mitigation exactly when an
    // injected form would need it.
    expect(createMcpConsentFormAction(uri)).toEqual({ _tag: 'Ok', formAction: '\'self\'' })
  })

  it('falls back to self for a loopback callback, whose port varies', () => {
    // CSP has no port wildcard, so an origin would pin the wrong port. The
    // post-approval redirect is a navigation, not a form post, so nothing
    // breaks.
    expect(createMcpConsentFormAction('http://127.0.0.1:8787/callback'))
      .toEqual({ _tag: 'Ok', formAction: '\'self\'' })
  })

  it('returns a decision instead of throwing on an unparseable callback', () => {
    // It used to throw a bare TypeError out of the consent-page renderer, so
    // a malformed registered redirect_uri produced a 500 where the page
    // should have been.
    expect(createMcpConsentFormAction('not a url'))
      .toEqual({ _tag: 'Err', reason: 'unparseable_redirect_uri' })
    expect(createMcpConsentFormAction('')).toEqual({ _tag: 'Err', reason: 'unparseable_redirect_uri' })
  })

  it('cannot emit a comma, which would split the CSP into two policies', () => {
    // WHATWG permits `"` and `,` in a host, so this callback registers and its
    // origin reached the header. A comma there is a policy separator, so the
    // allowance silently stopped applying. The previous version of this test
    // asserted on `;` and a space count and therefore passed on this input.
    expect(createMcpConsentFormAction('https://a%22%2Cx.com/cb'))
      .toEqual({ _tag: 'Ok', formAction: '\'self\'' })
  })

  it('emits nothing outside the host charset', () => {
    for (const uri of ['https://a%22x.com/cb', 'https://a%2Cx.com/cb']) {
      const decision = createMcpConsentFormAction(uri)

      expect(decision).toEqual({ _tag: 'Ok', formAction: '\'self\'' })
    }
  })

  it('keeps a legitimate origin, including a port and IPv6', () => {
    // The positive control for the charset gate: it must not reject real hosts.
    expect(createMcpConsentFormAction('https://example.com:8443/cb'))
      .toEqual({ _tag: 'Ok', formAction: '\'self\' https://example.com:8443' })
    expect(createMcpConsentFormAction('https://[2001:db8::1]/cb'))
      .toEqual({ _tag: 'Ok', formAction: '\'self\' https://[2001:db8::1]' })
  })
})

describe('createMcpConsentCacheControl', () => {
  it('keeps the page out of every shared cache', () => {
    expect(createMcpConsentCacheControl()).toBe('private, no-store, no-transform')
  })
})
