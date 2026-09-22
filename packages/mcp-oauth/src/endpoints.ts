/**
 * Where this deployment serves the OAuth protocol.
 *
 * Every path is configuration, never a constant, because two servers using
 * these rules already disagree. A single-Worker deployment owns `/oauth/*` at
 * the apex; a deployment split across Workers by an edge route table has to
 * nest under a prefix that table already binds. Hardcoding either one makes
 * the package unusable for the other.
 */
export interface McpOAuthEndpoints {
  /** The authorization endpoint, where consent is granted. */
  readonly authorize: string
  /** The token endpoint, where a code is exchanged. */
  readonly token: string
  /**
   * The RFC 7591 dynamic client registration endpoint, or `null` when this
   * server does not offer registration.
   */
  readonly register: string | null
  /** The protected resource: the path the bearer token opens. */
  readonly resource: string
}

/** RFC 9728 §3.1 well-known prefix for protected-resource metadata. */
export const PROTECTED_RESOURCE_WELL_KNOWN = '/.well-known/oauth-protected-resource'

/**
 * RFC 8414 §3 well-known path for authorization-server metadata.
 *
 * A complete path, not a prefix: RFC 8414 inserts this segment between the
 * authority and the issuer's own path component, and an issuer with no path
 * (what `resolveMcpOAuthIdentity` produces) has exactly this one URL.
 */
export const AUTHORIZATION_SERVER_WELL_KNOWN = '/.well-known/oauth-authorization-server'

/**
 * OpenID Connect discovery. Not served, but probed by real MCP clients, so it
 * is classified rather than left to the app's HTML 404.
 */
export const OPENID_CONFIGURATION_WELL_KNOWN = '/.well-known/openid-configuration'
