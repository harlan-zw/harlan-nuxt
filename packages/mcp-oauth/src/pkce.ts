/**
 * PKCE is mandatory, for confidential clients too.
 *
 * An authorization server that offers open dynamic client registration cannot
 * treat `token_endpoint_auth_method` as a trust signal. "Confidential" there
 * means only that the client self-declared a secret at registration time, and
 * anyone can register. `@cloudflare/workers-oauth-provider` requires PKCE only
 * when the method is `none`, so a self-declared confidential client can run
 * the whole authorization-code flow with no `code_challenge`.
 *
 * What that costs is authorization-code INJECTION (RFC 9700 §2.1). An attacker
 * who obtains a code cannot redeem it directly, because the token endpoint
 * does verify the registered secret, but they can inject it into their own
 * session with the legitimate client, whose client authentication then
 * succeeds on their behalf. PKCE binds the code to the session that began the
 * flow and is the only thing that stops it. Separately, a public client that
 * self-declares a secret has shipped that secret to its users, so the
 * "confidential" label is doing no work there either.
 *
 * Requiring S256 from every client closes both. Every MCP client already sends
 * it, so the rule costs nothing in practice.
 */
export type McpPkceDecision
  = | { _tag: 'Ok' }
    | {
      _tag: 'Err'
      reason: 'missing_code_challenge' | 'weak_code_challenge_method' | 'malformed_code_challenge'
    }

export interface McpPkceRequest {
  readonly codeChallenge?: string | null
  readonly codeChallengeMethod?: string | null
}

/** RFC 7636 §4.2: 43 to 128 characters from the unreserved set. */
const CODE_CHALLENGE_PATTERN = /^[\w\-.~]{43,128}$/

export function requireMcpPkce(request: McpPkceRequest): McpPkceDecision {
  if (!request.codeChallenge?.trim())
    return { _tag: 'Err', reason: 'missing_code_challenge' }
  // RFC 7636 §4.3 defaults an absent method to `plain`, which is no protection
  // at all. An absent method is therefore a rejection, not a lenient pass.
  if ((request.codeChallengeMethod ?? 'plain') !== 'S256')
    return { _tag: 'Err', reason: 'weak_code_challenge_method' }
  // Shape, not security: a degenerate challenge simply fails the provider's
  // own verifier comparison later. Rejecting it here turns a confusing
  // token-endpoint failure into an answer at the point of the mistake.
  if (!CODE_CHALLENGE_PATTERN.test(request.codeChallenge))
    return { _tag: 'Err', reason: 'malformed_code_challenge' }
  return { _tag: 'Ok' }
}
