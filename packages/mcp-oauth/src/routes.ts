import type { McpOAuthEndpoints } from './endpoints'
import {
  AUTHORIZATION_SERVER_WELL_KNOWN,
  OPENID_CONFIGURATION_WELL_KNOWN,
  PROTECTED_RESOURCE_WELL_KNOWN,
} from './endpoints'
import { normalizeMcpPath } from './normalize'

export type McpOAuthRouteDecision
  /** Not an OAuth or MCP path. Leave the request alone. */
  = | { _tag: 'Ignore' }
    /** The protected resource. Validate the bearer token before anything else. */
    | { _tag: 'ProtectedMcp' }
    /** A protocol or discovery path. The authorization server owns it. */
    | { _tag: 'OAuthProvider' }
    /**
     * A discovery path this server does not implement. Answer a JSON 404.
     *
     * A client probing discovery parses the body as JSON per RFC 6749 §5.2,
     * so an HTML error page surfaces to the user as "invalid OAuth error
     * response" rather than "this server has no OIDC discovery". The verdict
     * exists so that answer is a decision rather than whatever the app's
     * catch-all happens to render.
     */
    | { _tag: 'WellKnownNotFound' }

/**
 * Classify a request path against this deployment's endpoints.
 *
 * The path is normalised first (`normalizeMcpPath`). Comparing a raw path with
 * `===` was an authentication bypass: `POST /mcp/pro/` classified as `Ignore`,
 * the caller skipped the bearer check, and the router then folded the trailing
 * slash and served the request off the MCP handler anyway. Reproduced against
 * production, so this normalisation is the fix and not a precaution.
 *
 * Method-aware, because the method changes the answer rather than merely
 * failing later. `GET` on the token endpoint is not a token request, so it is
 * left to the app. `GET` on the protected resource IS classified, because MCP
 * Streamable HTTP opens the server-to-client SSE stream there: a server that
 * serves it and does not classify it streams to an unauthenticated caller,
 * while a server that answers 405 pays only a bearer check on a dead method.
 *
 * `OPTIONS` on the protected resource is classified, NOT ignored: the provider
 * answers the preflight with the CORS headers a browser-hosted MCP client
 * needs. A caller must therefore never turn `ProtectedMcp` into a bearer
 * challenge without checking the method first, because a preflight carries no
 * credential by definition and a 401 there stops the real request ever being
 * sent.
 */
export function matchMcpOAuthRoute(
  rawPath: string,
  method: string,
  endpoints: McpOAuthEndpoints,
): McpOAuthRouteDecision {
  const verb = method.toUpperCase()
  const path = normalizeMcpPath(rawPath)

  if (path === normalizeMcpPath(endpoints.resource))
    return allow(verb, ['GET', 'POST', 'DELETE', 'OPTIONS'], { _tag: 'ProtectedMcp' })

  if (path === normalizeMcpPath(endpoints.authorize))
    return allow(verb, ['GET', 'POST', 'OPTIONS'], { _tag: 'OAuthProvider' })

  const register = endpoints.register === null ? null : normalizeMcpPath(endpoints.register)
  if (path === normalizeMcpPath(endpoints.token) || (register !== null && path === register))
    return allow(verb, ['POST', 'OPTIONS'], { _tag: 'OAuthProvider' })

  // RFC 9728 §3.1 appends the resource path after the prefix, so a client asks
  // for `/.well-known/oauth-protected-resource/mcp/pro` and a prefix match is
  // required. The `/` is part of that match: without it the sibling path
  // `…-protected-resource-evil` would also be handed to the provider.
  if (path === PROTECTED_RESOURCE_WELL_KNOWN || path.startsWith(`${PROTECTED_RESOURCE_WELL_KNOWN}/`))
    return allow(verb, ['GET', 'HEAD', 'OPTIONS'], { _tag: 'OAuthProvider' })

  // RFC 8414 §3 is NOT the same shape. It inserts the well-known segment
  // between the authority and the issuer's path, and `resolveMcpOAuthIdentity`
  // produces a path-less issuer, so the exact root path is the only correct
  // URL here. Clients still try the path-suffixed form first; the provider
  // serves only the root, so routing the suffixed form to it yields a
  // text/plain 404. Answering it as a JSON not-found is the honest result.
  if (path === AUTHORIZATION_SERVER_WELL_KNOWN)
    return allow(verb, ['GET', 'HEAD', 'OPTIONS'], { _tag: 'OAuthProvider' })
  if (path.startsWith(`${AUTHORIZATION_SERVER_WELL_KNOWN}/`))
    return allow(verb, ['GET', 'HEAD', 'OPTIONS'], { _tag: 'WellKnownNotFound' })

  // An MCP client probing for an OIDC provider gets a definitive JSON answer
  // rather than the app's HTML 404.
  if (path === OPENID_CONFIGURATION_WELL_KNOWN || path.startsWith(`${OPENID_CONFIGURATION_WELL_KNOWN}/`))
    return allow(verb, ['GET', 'HEAD', 'OPTIONS'], { _tag: 'WellKnownNotFound' })

  return { _tag: 'Ignore' }
}

function allow(
  verb: string,
  methods: readonly string[],
  route: McpOAuthRouteDecision,
): McpOAuthRouteDecision {
  return methods.includes(verb) ? route : { _tag: 'Ignore' }
}
