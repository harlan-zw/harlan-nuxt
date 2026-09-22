/**
 * PKCE is mandatory, for confidential clients too.
 *
 * An authorization server that offers open dynamic client registration cannot
 * treat `token_endpoint_auth_method` as a trust signal. "Confidential" there
 * means only that the client self-declared a secret at registration time, and
 * anyone can register. `@cloudflare/workers-oauth-provider` requires PKCE only
 * when the method is `none`, so a self-declared confidential client can run
 * the whole authorization-code flow with no `code_challenge`. The code it
 * receives is then bearer-only: whoever sees the redirect can redeem it.
 *
 * Requiring S256 from every client closes that. Every MCP client already
 * sends it, so the rule costs nothing in practice.
 */
export type McpPkceDecision
  = | { _tag: 'Ok' }
    | { _tag: 'Err', reason: 'missing_code_challenge' | 'weak_code_challenge_method' }

export interface McpPkceRequest {
  codeChallenge?: string | null
  codeChallengeMethod?: string | null
}

export function requireMcpPkce(request: McpPkceRequest): McpPkceDecision {
  if (!request.codeChallenge?.trim())
    return { _tag: 'Err', reason: 'missing_code_challenge' }
  // RFC 7636 §4.3 defaults an absent method to `plain`, which is no protection
  // at all. An absent method is therefore a rejection, not a lenient pass.
  if ((request.codeChallengeMethod ?? 'plain') !== 'S256')
    return { _tag: 'Err', reason: 'weak_code_challenge_method' }
  return { _tag: 'Ok' }
}
