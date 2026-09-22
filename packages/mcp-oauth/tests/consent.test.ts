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

  it('cannot be tricked into a second CSP directive', () => {
    // An origin cannot contain a space or a semicolon, so this stays one
    // directive; the assertion pins it rather than assuming it.
    const decision = createMcpConsentFormAction('https://a%22%2Cx.com/cb')

    expect(decision).toMatchObject({ _tag: 'Ok' })
    if (decision._tag === 'Ok') {
      expect(decision.formAction).not.toContain(';')
      expect(decision.formAction.split(' ')).toHaveLength(2)
    }
  })
})

describe('createMcpConsentCacheControl', () => {
  it('keeps the page out of every shared cache', () => {
    expect(createMcpConsentCacheControl()).toBe('private, no-store, no-transform')
  })
})
