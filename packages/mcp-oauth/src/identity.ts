import type { McpOAuthEndpoints } from './endpoints'
import { PROTECTED_RESOURCE_WELL_KNOWN } from './endpoints'

/**
 * The RFC 8707 / RFC 8414 / RFC 9728 identifiers this deployment advertises.
 */
export interface McpOAuthIdentity {
  /** RFC 8707 resource indicator. */
  readonly resource: string
  /** RFC 8414 issuer. */
  readonly authorizationServer: string
  /** RFC 9728 metadata document for the protected resource. */
  readonly resourceMetadataUrl: string
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
 * SECURITY. With `configuredOrigin` unset this derives from the request URL,
 * which both Workers and Node build from the `Host` header. That header is
 * attacker-controlled on every request, so a poisoned `Host` steers the
 * advertised issuer, the RFC 8707 resource and the `resource_metadata` pointer
 * in the 401 challenge at a server of the attacker's choosing, and any cache
 * in front of those responses serves the poisoned value on. Validate
 * `url.host` against a known set, or set `configuredOrigin`, before trusting
 * this in production. Deriving is the right DEFAULT because hardcoding makes
 * every preview deploy unfinishable; it is not a substitute for a host check.
 *
 * The resulting `resource` is load-bearing beyond this function: a provider
 * that is not told its canonical resource accepts whatever `resource` a client
 * sends and mints tokens with that audience, so both RFC 8707 validation and
 * audience binding are silently lost. Feed `identity.resource` into the
 * provider's resource metadata.
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
  const origin = new URL(value).origin
  // `URL.canParse` accepts `file:///x` and `mailto:a@b.c`, whose origin is the
  // literal string 'null'. Advertising `authorizationServer: 'null'` and
  // `resource: 'null/mcp'` is worse than ignoring the setting.
  if (origin === 'null')
    return null
  return origin
}
