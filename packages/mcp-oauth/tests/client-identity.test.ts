import { describe, expect, it } from 'vitest'
import {
  assessMcpCallbackScheme,
  assessMcpClientIdentity,
  assessMcpClientName,
  assessMcpRedirectUri,
  describeMcpCallbackDestination,
  isMcpLoopbackCallback,
  isMcpLoopbackUrl,
  readMcpUrl,
} from '../src/index'

const policy = { reservedNames: ['Acme Cloud', 'gscdump'] }

describe('assessMcpClientName', () => {
  it('accepts a client registering under its own product name', () => {
    expect(assessMcpClientName('ChatGPT', policy)).toEqual({ _tag: 'Ok' })
    expect(assessMcpClientName('Claude Code', policy)).toEqual({ _tag: 'Ok' })
  })

  it.each([
    'Acme Cloud Pro',
    'acmecloud',
    'Acme-Cloud',
    'Acme.Cloud',
    'Acme_Cloud',
    'ACME  CLOUD',
    'Acme​Cloud',
    'Ａｃｍｅ Ｃｌｏｕｄ',
    'Ácme Cloud',
    'Official gscdump connector',
  ])('refuses %j', (name) => {
    // `Acme-Cloud` is the case that matters most: it is the more natural
    // spelling of the brand and a `\s*`-joined regex let it straight through.
    expect(assessMcpClientName(name, policy)).toMatchObject({ _tag: 'Err' })
  })

  it('names which reserved word was matched', () => {
    expect(assessMcpClientName('Acme-Cloud', policy))
      .toEqual({ _tag: 'Err', reason: 'reserved_client_name', matched: 'Acme Cloud' })
  })

  it('leaves a non-string name to the provider', () => {
    // Made observable: a reserved word that a coerced value would contain must
    // still pass, which pins the early return rather than the coercion.
    expect(assessMcpClientName(undefined, { reservedNames: ['undefined'] })).toEqual({ _tag: 'Ok' })
    expect(assessMcpClientName(42, policy)).toEqual({ _tag: 'Ok' })
  })

  it('does not refuse everything when a reserved entry is blank', () => {
    // A blank entry reducing to an empty skeleton would match every name, so
    // every registration on the server fails: an outage, not a guard.
    expect(assessMcpClientName('ChatGPT', { reservedNames: ['', '   ', '---'] }))
      .toEqual({ _tag: 'Ok' })
  })

  it('still enforces a real entry alongside a blank one', () => {
    expect(assessMcpClientName('Acme Cloud', { reservedNames: ['', 'Acme Cloud'] }))
      .toMatchObject({ _tag: 'Err' })
  })

  it('accepts a name that reduces to nothing', () => {
    expect(assessMcpClientName('---', policy)).toEqual({ _tag: 'Ok' })
  })

  it('reserves nothing when the policy reserves nothing', () => {
    expect(assessMcpClientName('Acme Cloud', { reservedNames: [] })).toEqual({ _tag: 'Ok' })
  })
})

describe('assessMcpCallbackScheme', () => {
  it('refuses a custom scheme claiming a reserved brand', () => {
    // The destination line renders a custom-scheme callback as its scheme, so
    // guarding only the name moves the impersonation instead of stopping it.
    expect(assessMcpCallbackScheme('acmecloud://x/y', policy)).toMatchObject({ _tag: 'Err' })
    expect(assessMcpCallbackScheme('acme-cloud://x/y', policy)).toMatchObject({ _tag: 'Err' })
  })

  it('allows an unreserved custom scheme', () => {
    expect(assessMcpCallbackScheme('cursor://anysphere.cursor-mcp/oauth/callback', policy))
      .toEqual({ _tag: 'Ok' })
  })

  it('ignores http and https, whose destination is the host', () => {
    expect(assessMcpCallbackScheme('https://acmecloud.attacker.example/cb', policy))
      .toEqual({ _tag: 'Ok' })
  })
})

describe('assessMcpRedirectUri', () => {
  it('accepts https and loopback http', () => {
    expect(assessMcpRedirectUri('https://chatgpt.com/cb')).toEqual({ _tag: 'Ok' })
    expect(assessMcpRedirectUri('http://127.0.0.1:8787/cb')).toEqual({ _tag: 'Ok' })
    expect(assessMcpRedirectUri('http://localhost/cb')).toEqual({ _tag: 'Ok' })
    // RFC 8252 §7.3 is the whole 127/8 range, which the provider also matches.
    expect(assessMcpRedirectUri('http://127.0.0.2:5173/cb')).toEqual({ _tag: 'Ok' })
  })

  it('refuses plaintext http on a remote host', () => {
    // The provider permits this; OAuth 2.1 does not. Codes would travel in
    // cleartext to a host the registrant chose.
    expect(assessMcpRedirectUri('http://attacker.example/cb'))
      .toEqual({ _tag: 'Err', reason: 'insecure_redirect_uri', detail: 'attacker.example' })
  })

  it('allows plaintext http only when the operator opts in', () => {
    expect(assessMcpRedirectUri('http://attacker.example/cb', { allowInsecureRedirectUri: true }))
      .toEqual({ _tag: 'Ok' })
  })

  it('refuses a fragment', () => {
    // RFC 6749 §3.1.2: the fragment is where an implicit-flow token lands.
    expect(assessMcpRedirectUri('https://chatgpt.com/cb#x'))
      .toEqual({ _tag: 'Err', reason: 'redirect_uri_fragment' })
  })

  it('refuses an unparseable value', () => {
    expect(assessMcpRedirectUri('not a url'))
      .toEqual({ _tag: 'Err', reason: 'unparseable_redirect_uri' })
  })
})

describe('assessMcpClientIdentity', () => {
  const full = { ...policy, ownedHosts: ['acmecloud.com'] }

  it('marks an ordinary registered client unverified', () => {
    expect(assessMcpClientIdentity(
      { clientId: 'C6o_YeNTyRaZmHjA', clientName: 'ChatGPT', redirectUri: 'https://chatgpt.com/cb' },
      full,
    )).toEqual({ _tag: 'Ok', verification: 'unverified' })
  })

  it('verifies a client whose client id is on a host the operator owns', () => {
    // A CIMD client id is an https URL whose host served the metadata, which
    // is the only self-proving signal in a claimed identity.
    expect(assessMcpClientIdentity(
      { clientId: 'https://acmecloud.com/cimd.json', clientName: 'Acme Cloud', redirectUri: 'https://acmecloud.com/cb' },
      full,
    )).toEqual({ _tag: 'Ok', verification: 'verified' })
  })

  it('lets a verified first-party client use the reserved name', () => {
    // Without this the reserved-name rule locks the operator out of their own
    // brand, and they turn the rule off.
    expect(assessMcpClientIdentity(
      { clientId: 'https://acmecloud.com/cimd.json', clientName: 'Acme Cloud Pro', redirectUri: 'https://acmecloud.com/cb' },
      full,
    )).toMatchObject({ _tag: 'Ok' })
  })

  it('refuses a reserved name on a host the operator does not own', () => {
    // The CIMD bypass: this claim never passes through registration, so a
    // registration-only check never sees it.
    expect(assessMcpClientIdentity(
      { clientId: 'https://evil.example/cimd.json', clientName: 'Acme Cloud', redirectUri: 'https://evil.example/cb' },
      full,
    )).toMatchObject({ _tag: 'Err', reason: 'reserved_client_name' })
  })

  it('refuses a look-alike owned host', () => {
    expect(assessMcpClientIdentity(
      { clientId: 'https://acmecloud.com.evil.example/c.json', clientName: 'Acme Cloud', redirectUri: 'https://evil.example/cb' },
      full,
    )).toMatchObject({ _tag: 'Err', reason: 'reserved_client_name' })
  })

  it('refuses a reserved callback scheme', () => {
    expect(assessMcpClientIdentity(
      { clientId: 'abc', clientName: 'Helper', redirectUri: 'acmecloud://x/y' },
      full,
    )).toMatchObject({ _tag: 'Err', reason: 'reserved_callback_scheme' })
  })

  it('checks the callback before the name, so an insecure callback is named as such', () => {
    expect(assessMcpClientIdentity(
      { clientId: 'abc', clientName: 'Acme Cloud', redirectUri: 'http://evil.example/cb' },
      full,
    )).toMatchObject({ _tag: 'Err', reason: 'insecure_redirect_uri' })
  })

  it('cannot verify anything when the operator declares no owned hosts', () => {
    expect(assessMcpClientIdentity(
      { clientId: 'https://acmecloud.com/cimd.json', clientName: 'ChatGPT', redirectUri: 'https://acmecloud.com/cb' },
      policy,
    )).toEqual({ _tag: 'Ok', verification: 'unverified' })
  })
})

describe('describeMcpCallbackDestination', () => {
  it('shows the host a hosted connector will receive the code on', () => {
    expect(describeMcpCallbackDestination('https://chatgpt.com/connector/oauth/x'))
      .toBe('chatgpt.com')
  })

  it('keeps a non-default port, because it is part of the destination', () => {
    expect(describeMcpCallbackDestination('https://example.com:8443/cb')).toBe('example.com:8443')
  })

  it.each([
    'http://localhost:8787/callback',
    'http://127.0.0.1/callback',
    'http://127.0.0.2:5173/callback',
    'http://[::1]:1455/callback',
  ])('names %s as this computer', (uri) => {
    expect(describeMcpCallbackDestination(uri)).toBe('this computer')
  })

  it('qualifies a custom scheme instead of printing it bare', () => {
    // A bare `cursor` in the destination slot reads as an endorsement.
    expect(describeMcpCallbackDestination('cursor://anysphere.cursor-mcp/oauth/callback'))
      .toBe('the cursor app on this computer')
  })

  it('drops userinfo, which is the classic host spoof', () => {
    expect(describeMcpCallbackDestination('https://chatgpt.com@attacker.example/cb'))
      .toBe('attacker.example')
  })

  it('returns an unparseable value unchanged rather than hiding it', () => {
    // Showing something wrong is recoverable. Showing nothing where the
    // destination belongs is the failure the line exists to prevent. Callers
    // must HTML-escape it; the doc comment says so.
    expect(describeMcpCallbackDestination('not a url')).toBe('not a url')
  })

  it('does not call a remote host loopback', () => {
    expect(describeMcpCallbackDestination('https://localhost.attacker.example/cb'))
      .toBe('localhost.attacker.example')
    expect(describeMcpCallbackDestination('https://127.0.0.1.attacker.example/cb'))
      .toBe('127.0.0.1.attacker.example')
  })

  it('does not call an https loopback this computer', () => {
    // Only http loopback is the desktop-client shape.
    expect(describeMcpCallbackDestination('https://127.0.0.1/cb')).toBe('127.0.0.1')
  })
})

describe('isMcpLoopbackCallback', () => {
  it('separates a real loopback from a look-alike host', () => {
    expect(isMcpLoopbackCallback('http://127.0.0.1:1455/callback')).toBe(true)
    expect(isMcpLoopbackCallback('http://[::1]/callback')).toBe(true)
    expect(isMcpLoopbackCallback('https://127.0.0.1.attacker.example/callback')).toBe(false)
    expect(isMcpLoopbackCallback('https://127.0.0.1/callback')).toBe(false)
    expect(isMcpLoopbackCallback('not a url')).toBe(false)
  })
})

describe('isMcpLoopbackUrl', () => {
  it('narrows an already-parsed URL, which is what a consent renderer holds', () => {
    const url = readMcpUrl('http://127.0.0.1:8787/callback')

    expect(isMcpLoopbackUrl(url)).toBe(true)
    expect(isMcpLoopbackUrl(readMcpUrl('not a url'))).toBe(false)
    expect(isMcpLoopbackUrl(null)).toBe(false)
  })
})
