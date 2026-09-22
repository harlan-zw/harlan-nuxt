import { describe, expect, it } from 'vitest'
import { requireMcpPkce } from '../src/pkce'

describe('requireMcpPkce', () => {
  it('accepts an S256 challenge', () => {
    expect(requireMcpPkce({ codeChallenge: 'a'.repeat(43), codeChallengeMethod: 'S256' }))
      .toEqual({ _tag: 'Ok' })
  })

  it('refuses a request with no challenge', () => {
    // The whole point of the rule: a confidential client would otherwise get
    // here, and `@cloudflare/workers-oauth-provider` would let it through.
    expect(requireMcpPkce({})).toEqual({ _tag: 'Err', reason: 'missing_code_challenge' })
  })

  it('refuses a whitespace-only challenge', () => {
    expect(requireMcpPkce({ codeChallenge: '   ', codeChallengeMethod: 'S256' }))
      .toEqual({ _tag: 'Err', reason: 'missing_code_challenge' })
  })

  it('refuses plain', () => {
    expect(requireMcpPkce({ codeChallenge: 'a'.repeat(43), codeChallengeMethod: 'plain' }))
      .toEqual({ _tag: 'Err', reason: 'weak_code_challenge_method' })
  })

  it('refuses an absent method rather than defaulting it', () => {
    // RFC 7636 defaults an absent method to `plain`. Reading the absence as
    // "probably S256" would accept exactly the flow the rule exists to stop.
    expect(requireMcpPkce({ codeChallenge: 'a'.repeat(43) }))
      .toEqual({ _tag: 'Err', reason: 'weak_code_challenge_method' })
  })

  it('refuses an unknown method', () => {
    expect(requireMcpPkce({ codeChallenge: 'a'.repeat(43), codeChallengeMethod: 'S512' }))
      .toEqual({ _tag: 'Err', reason: 'weak_code_challenge_method' })
  })
})
