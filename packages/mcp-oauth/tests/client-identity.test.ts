import { describe, expect, it } from 'vitest'
import {
  assessMcpClientName,
  describeMcpCallbackDestination,
  isMcpLoopbackCallback,
} from '../src/client-identity'

const policy = { reservedNames: ['Nuxt SEO', 'gscdump'] }

describe('assessMcpClientName', () => {
  it('accepts a client registering under its own product name', () => {
    expect(assessMcpClientName('ChatGPT', policy)).toEqual({ _tag: 'Ok' })
    expect(assessMcpClientName('Claude Code', policy)).toEqual({ _tag: 'Ok' })
  })

  it('refuses a client claiming a reserved name', () => {
    expect(assessMcpClientName('Nuxt SEO Pro', policy))
      .toEqual({ _tag: 'Err', reason: 'reserved_client_name', matched: 'Nuxt SEO' })
  })

  it('refuses the same name with the spacing collapsed or padded', () => {
    // An operator protects "Nuxt SEO"; an attacker types "nuxtseo". Matching
    // the literal string only would make the rule trivially evadable.
    for (const name of ['nuxtseo', 'NUXTSEO Assistant', 'nuxt  seo helper', 'NuxtSeo']) {
      expect(assessMcpClientName(name, policy)).toMatchObject({ _tag: 'Err' })
    }
  })

  it('matches a reserved name anywhere in the value', () => {
    expect(assessMcpClientName('Official gscdump connector', policy))
      .toMatchObject({ _tag: 'Err', matched: 'gscdump' })
  })

  it('leaves a non-string name to the provider', () => {
    expect(assessMcpClientName(undefined, policy)).toEqual({ _tag: 'Ok' })
    expect(assessMcpClientName(42, policy)).toEqual({ _tag: 'Ok' })
  })

  it('does not match everything when a reserved entry is blank', () => {
    // A blank entry compiling to an empty pattern would reject every
    // registration on the server, which is a total outage rather than a guard.
    expect(assessMcpClientName('ChatGPT', { reservedNames: ['', '   '] }))
      .toEqual({ _tag: 'Ok' })
  })

  it('treats a regex metacharacter in a reserved name as a literal', () => {
    expect(assessMcpClientName('anything', { reservedNames: ['a.c'] })).toEqual({ _tag: 'Ok' })
    expect(assessMcpClientName('a.c corp', { reservedNames: ['a.c'] })).toMatchObject({ _tag: 'Err' })
  })

  it('grants no names when the policy reserves none', () => {
    expect(assessMcpClientName('Nuxt SEO Pro', { reservedNames: [] })).toEqual({ _tag: 'Ok' })
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

  it('names a loopback callback in words a user can act on', () => {
    for (const uri of ['http://localhost:8787/callback', 'http://127.0.0.1/callback']) {
      expect(describeMcpCallbackDestination(uri)).toBe('this computer')
    }
  })

  it('shows the scheme for a custom-scheme callback', () => {
    expect(describeMcpCallbackDestination('cursor://anysphere.cursor-mcp/oauth/callback'))
      .toBe('cursor')
  })

  it('returns an unparseable value unchanged rather than hiding it', () => {
    // Showing something wrong is recoverable. Showing nothing where the
    // destination belongs is the failure this page exists to prevent.
    expect(describeMcpCallbackDestination('not a url')).toBe('not a url')
  })

  it('does not call a remote host loopback', () => {
    expect(describeMcpCallbackDestination('https://localhost.attacker.example/cb'))
      .toBe('localhost.attacker.example')
  })
})

describe('isMcpLoopbackCallback', () => {
  it('separates a real loopback from a look-alike host', () => {
    expect(isMcpLoopbackCallback('http://127.0.0.1:1455/callback')).toBe(true)
    expect(isMcpLoopbackCallback('https://127.0.0.1.attacker.example/callback')).toBe(false)
    expect(isMcpLoopbackCallback('not a url')).toBe(false)
  })
})
