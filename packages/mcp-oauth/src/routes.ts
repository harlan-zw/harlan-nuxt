import type { McpOAuthEndpoints } from './endpoints'
import { AUTHORIZATION_SERVER_WELL_KNOWN, PROTECTED_RESOURCE_WELL_KNOWN } from './endpoints'

export type McpOAuthRoute
  /** Not an OAuth or MCP path. Leave the request alone. */
  = | { _tag: 'Ignore' }
    /** The protected resource. Validate the bearer token. */
    | { _tag: 'ProtectedMcp' }
    /** A protocol or discovery path. The authorization server owns it. */
    | { _tag: 'OAuthProvider' }

/**
 * Classify a request path against this deployment's endpoints.
 *
 * Method-aware, because the method changes the answer rather than merely
 * failing later. A CORS preflight carries no credential by definition, so
 * challenging `OPTIONS` on the protected resource with a 401 stops the real
 * request from ever being sent. `GET` on the token endpoint is not a token
 * request. Returning `Ignore` for those leaves them to the normal handler
 * instead of inventing a protocol answer.
 */
export function matchMcpOAuthRoute(
  path: string,
  method: string,
  endpoints: McpOAuthEndpoints,
): McpOAuthRoute {
  const verb = method.toUpperCase()

  if (path === endpoints.resource)
    return allow(verb, ['POST', 'DELETE', 'OPTIONS'], { _tag: 'ProtectedMcp' })

  if (path === endpoints.authorize)
    return allow(verb, ['GET', 'POST', 'OPTIONS'], { _tag: 'OAuthProvider' })

  if (path === endpoints.token || (endpoints.register !== null && path === endpoints.register))
    return allow(verb, ['POST', 'OPTIONS'], { _tag: 'OAuthProvider' })

  for (const wellKnown of [AUTHORIZATION_SERVER_WELL_KNOWN, PROTECTED_RESOURCE_WELL_KNOWN]) {
    // RFC 8414 allows the resource path to be appended to the well-known
    // prefix, so a prefix match is required, not equality.
    if (path === wellKnown || path.startsWith(`${wellKnown}/`))
      return allow(verb, ['GET', 'OPTIONS'], { _tag: 'OAuthProvider' })
  }

  return { _tag: 'Ignore' }
}

function allow(verb: string, methods: string[], route: McpOAuthRoute): McpOAuthRoute {
  return methods.includes(verb) ? route : { _tag: 'Ignore' }
}
