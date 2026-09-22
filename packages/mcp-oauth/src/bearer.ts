/**
 * Reading and challenging bearer credentials.
 *
 * The challenge matters more than it looks: `WWW-Authenticate` carrying the
 * RFC 9728 `resource_metadata` pointer is the only thing an MCP client has to
 * trigger the OAuth flow on. A protected endpoint that answers an
 * unauthenticated call with a bare JSON error leaves ChatGPT and Claude.ai
 * with nothing to start from, and the connector simply fails to connect.
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

/** RFC 6750 §3 challenge, carrying the RFC 9728 pointer. */
export function createMcpBearerChallenge(input: {
  resourceMetadataUrl: string
  error: McpBearerErrorCode
  scope?: string
}): string {
  const parts = [
    `Bearer resource_metadata="${input.resourceMetadataUrl}"`,
    `error="${input.error}"`,
  ]
  if (input.scope)
    parts.push(`scope="${input.scope}"`)
  return parts.join(', ')
}

/** The HTTP status an error code answers with. */
export function mcpBearerErrorStatus(error: McpBearerErrorCode): number {
  if (error === 'insufficient_scope')
    return 403
  if (error === 'invalid_request')
    return 400
  return 401
}
