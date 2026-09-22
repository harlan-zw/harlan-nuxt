import type { McpOAuthEndpoints } from './endpoints'
import { PROTECTED_RESOURCE_WELL_KNOWN } from './endpoints'

/**
 * The RFC 8707 / RFC 8414 / RFC 9728 identifiers this deployment advertises.
 */
export interface McpOAuthIdentity {
  /** RFC 8707 resource indicator. */
  resource: string
  /** RFC 8414 issuer. */
  authorizationServer: string
  /** RFC 9728 metadata document for the protected resource. */
  resourceMetadataUrl: string
}

/**
 * Derive the deployment's OAuth identity from the request URL.
 *
 * Deriving beats hardcoding an origin. A server with production literals
 * baked in advertises production URLs from every staging and preview deploy,
 * and no client can complete a flow against one: the identifiers it is handed
 * name a different server. Those literals reach the 401 challenge, the
 * resource indicator and the metadata documents, so the bug is total and
 * shows up only once someone tries to connect to staging.
 *
 * `configuredOrigin` wins when set, for a deployment behind a proxy whose
 * forwarded host cannot be trusted.
 */
export function resolveMcpOAuthIdentity(
  requestUrl: string | URL,
  endpoints: McpOAuthEndpoints,
  configuredOrigin?: string,
): McpOAuthIdentity {
  const url = typeof requestUrl === 'string' ? new URL(requestUrl) : requestUrl
  const origin = normalizeOrigin(configuredOrigin) ?? url.origin
  return {
    resource: `${origin}${endpoints.resource}`,
    authorizationServer: origin,
    resourceMetadataUrl: `${origin}${PROTECTED_RESOURCE_WELL_KNOWN}${endpoints.resource}`,
  }
}

function normalizeOrigin(value: string | undefined): string | null {
  if (!value?.trim())
    return null
  if (!URL.canParse(value))
    return null
  return new URL(value).origin
}
