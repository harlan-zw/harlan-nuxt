// Framework-free policy rules for an MCP OAuth 2.1 authorization server.
//
// Everything here is a pure rule: request facts in, a decision or a derived
// value out, no I/O, no storage, no framework. That is what makes the security
// rules testable without a Worker, a KV namespace or a provider instance, and
// what lets two servers with completely different transports share them.
//
// What this package deliberately does NOT own: the consent page's markup and
// copy, the grant payload shape, token storage, and the provider wiring. Those
// are the parts that know what the product is.

export {
  createMcpBearerChallenge,
  mcpBearerErrorStatus,
  readBearerToken,
} from './bearer'
export type { McpBearerChallengeInput, McpBearerErrorCode } from './bearer'

export { exceedsMcpBodyLimit, MCP_BODY_LIMIT_BYTES } from './body'

export {
  assessMcpCallbackScheme,
  assessMcpClientIdentity,
  assessMcpClientName,
  assessMcpRedirectUri,
  describeMcpCallbackDestination,
  isMcpLoopbackCallback,
  isMcpLoopbackUrl,
  readMcpUrl,
} from './client-identity'
export type {
  McpClientIdentityClaim,
  McpClientIdentityDecision,
  McpClientIdentityPolicy,
  McpClientNameDecision,
  McpRedirectUriDecision,
} from './client-identity'

export { createMcpConsentCacheControl, createMcpConsentFormAction } from './consent'
export type { McpConsentFormActionDecision } from './consent'

export {
  createMcpConsentSecrets,
  createMcpRandomToken,
  verifyMcpCsrfToken,
} from './csrf'
export type { McpConsentSecrets } from './csrf'

export {
  AUTHORIZATION_SERVER_WELL_KNOWN,
  OPENID_CONFIGURATION_WELL_KNOWN,
  PROTECTED_RESOURCE_WELL_KNOWN,
} from './endpoints'
export type { McpOAuthEndpoints } from './endpoints'

export { resolveMcpOAuthIdentity } from './identity'
export type { McpOAuthIdentity } from './identity'

export { isMcpHostOwnedBy, mcpNameSkeleton, normalizeMcpPath } from './normalize'

export { requireMcpPkce } from './pkce'
export type { McpPkceDecision, McpPkceRequest } from './pkce'

export { matchMcpOAuthRoute } from './routes'
export type { McpOAuthRouteDecision } from './routes'

export { grantedMcpScopes, mcpRefreshTokenTtl } from './scopes'
export type { McpScopeDecision, McpScopePolicy } from './scopes'
