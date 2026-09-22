/**
 * Reading and challenging bearer credentials.
 *
 * The challenge matters more than it looks: `WWW-Authenticate` carrying the
 * RFC 9728 `resource_metadata` pointer is what an MCP client triggers the
 * OAuth flow on. A protected endpoint that answers an unauthenticated call
 * with a bare JSON error leaves a connector with nothing to start from.
 * (Well-behaved clients also probe the discovery documents directly, so the
 * header is the reliable path rather than the only one.)
 */

export function readBearerToken(authorization: string | null | undefined): string | null {
  if (!authorization)
    return null
  const [scheme, ...rest] = authorization.split(' ')
  if (scheme?.toLowerCase() !== 'bearer')
    return null
  const token = rest.join(' ').trim()
  return token || null
}

export type McpBearerErrorCode = 'invalid_token' | 'insufficient_scope' | 'invalid_request'

export interface McpBearerChallengeInput {
  resourceMetadataUrl: string
  /**
   * Omit for a request that carried NO credential. RFC 6750 §3 says a bare
   * challenge should not name an error in that case, and some clients treat
   * `error="invalid_token"` on a missing header as a hard failure rather than
   * an invitation to authenticate.
   */
  error?: McpBearerErrorCode
  scope?: string
}

/**
 * RFC 6750 §3 challenge, carrying the RFC 9728 pointer.
 *
 * Both interpolated values are sanitised. They are not as trusted as they
 * look: `resourceMetadataUrl` is derived from the request origin, and a
 * `"`, `,` or `=` is a legal host character, so an attacker-supplied Host
 * header could close the quoted string early and append auth-params of their
 * choosing ahead of the real `error`. `scope` is a bare string that the
 * obvious caller fills from the client's own scope request.
 */
export function createMcpBearerChallenge(input: McpBearerChallengeInput): string {
  const parts = [`Bearer resource_metadata="${quoteAuthParam(input.resourceMetadataUrl)}"`]
  if (input.error)
    parts.push(`error="${quoteAuthParam(input.error)}"`)
  if (input.scope)
    parts.push(`scope="${quoteAuthParam(input.scope)}"`)
  return parts.join(', ')
}

/**
 * Make a value safe inside an RFC 7230 quoted-string.
 *
 * Every C0 control and DEL goes entirely: CR and LF split the header, and the
 * rest are not valid `qdtext` per RFC 9110 §5.6.4. A `"` or `\` is
 * backslash-escaped, which is what a quoted-string permits and what keeps the
 * parameter one parameter. A WHATWG-serialised URL contains none of these, so
 * no legitimate value is altered.
 */
function quoteAuthParam(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replaceAll(/[\0-\x1F\x7F]/g, '')
    .replaceAll(/["\\]/g, match => `\\${match}`)
}

/** The HTTP status an error code answers with. */
export function mcpBearerErrorStatus(error: McpBearerErrorCode | undefined): number {
  switch (error) {
    case 'insufficient_scope':
      return 403
    case 'invalid_request':
      return 400
    case 'invalid_token':
    case undefined:
      return 401
    default: {
      // Exhaustiveness: a new code must choose a status here rather than
      // silently inheriting 401.
      const never: never = error
      return never
    }
  }
}
