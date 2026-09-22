/**
 * Who a consent page says is asking, and where the grant actually goes.
 *
 * With open dynamic client registration the consent page IS the whole defence,
 * and every part of a client's claimed identity is self-declared: the name,
 * the callback, and the callback's scheme. A page that shows the name alone
 * renders an attacker's client identically to a real one.
 *
 * WHERE TO CALL THIS. `assessMcpClientIdentity` must run at consent time, not
 * only at registration. A provider's registration callback covers RFC 7591
 * clients only; a Client-ID Metadata Document client (CIMD, an https client id
 * whose host serves its own metadata) never passes through registration at
 * all, so a registration-only check is bypassed by choosing a client id
 * instead of POSTing to `/register`. Nothing in the CIMD document's own rules
 * constrains its `redirect_uris` to the client-id host either.
 */

import { isMcpHostOwnedBy, mcpNameSkeleton } from './normalize'

/**
 * What a registering or authorizing client claims about itself.
 *
 * Every field is attacker-controlled. `clientId` is the one exception worth
 * knowing about: for a CIMD client it is an https URL whose host actually
 * served the metadata document, which makes its host the only self-proving
 * signal in the set.
 */
export interface McpClientIdentityClaim {
  clientId: string
  clientName: unknown
  redirectUri: string
}

export interface McpClientIdentityPolicy {
  /**
   * Brand words this server reserves. Compared as skeletons, so spacing,
   * punctuation, case, full-width forms, diacritics and zero-width characters
   * do not evade the rule. `['Acme Cloud']` blocks `Acme-Cloud` and
   * `acme_cloud` alike.
   */
  readonly reservedNames: readonly string[]
  /**
   * Hosts this server owns. A claim whose client id is on one of them is
   * `verified`, and is allowed to use a reserved name: that is the operator's
   * own first-party client.
   */
  readonly ownedHosts?: readonly string[]
  /**
   * Allow a plain-http callback on a non-loopback host. Off by default: the
   * provider permits it, OAuth 2.1 does not, and it puts authorization codes
   * on the wire in cleartext.
   */
  readonly allowInsecureRedirectUri?: boolean
}

export type McpClientIdentityDecision
  = | {
    _tag: 'Ok'
    /**
     * `verified` only when something independent of the claim vouched for it:
     * the client id is on a host the operator owns. Everything else is
     * `unverified`, and a consent page must say so, because the name above it
     * was chosen by whoever set the connection up.
     */
    verification: 'verified' | 'unverified'
  }
  | {
    _tag: 'Err'
    reason:
      | 'reserved_client_name'
      | 'reserved_callback_scheme'
      | 'insecure_redirect_uri'
      | 'redirect_uri_fragment'
      | 'unparseable_redirect_uri'
    detail?: string
  }

/**
 * Judge a client's whole claimed identity in one decision.
 *
 * Name, callback scheme and callback security are one rule rather than three
 * because they are one attack: an attacker only needs whichever of them a
 * given consent page happens to render. Guarding the name while printing an
 * attacker-chosen `acmecloud:` scheme in the destination line moves the
 * impersonation, it does not stop it.
 */
export function assessMcpClientIdentity(
  claim: McpClientIdentityClaim,
  policy: McpClientIdentityPolicy,
): McpClientIdentityDecision {
  const redirect = assessMcpRedirectUri(claim.redirectUri, policy)
  if (redirect._tag === 'Err')
    return redirect

  const clientHost = readMcpUrlHost(claim.clientId)
  const verified = clientHost !== null
    && policy.ownedHosts !== undefined
    && isMcpHostOwnedBy(clientHost, policy.ownedHosts)

  // A verified first-party client is the legitimate holder of the brand name,
  // so the reserved-name rule must not lock the operator out of their own.
  if (!verified) {
    const name = assessMcpClientName(claim.clientName, policy)
    if (name._tag === 'Err')
      return { _tag: 'Err', reason: 'reserved_client_name', detail: name.matched }

    const scheme = assessMcpCallbackScheme(claim.redirectUri, policy)
    if (scheme._tag === 'Err')
      return { _tag: 'Err', reason: 'reserved_callback_scheme', detail: scheme.matched }
  }

  return { _tag: 'Ok', verification: verified ? 'verified' : 'unverified' }
}

export type McpClientNameDecision
  = | { _tag: 'Ok' }
    | { _tag: 'Err', reason: 'reserved_client_name', matched: string }

/**
 * Refuse a client claiming a name this server reserves.
 *
 * `client_name` is the headline of the consent page, so our own name over an
 * attacker's callback reads as first-party. Compared as skeletons: an earlier
 * version joined the words with `\s*` and was defeated by a single hyphen.
 */
export function assessMcpClientName(
  clientName: unknown,
  policy: Pick<McpClientIdentityPolicy, 'reservedNames'>,
): McpClientNameDecision {
  // A non-string name is the provider's shape problem, not this rule's. It is
  // never rendered as a brand, because a caller that reaches a consent page
  // with a non-string name has already lost the name to its own coercion.
  if (typeof clientName !== 'string')
    return { _tag: 'Ok' }
  const candidate = mcpNameSkeleton(clientName)
  if (candidate === '')
    return { _tag: 'Ok' }
  for (const reserved of policy.reservedNames) {
    const skeleton = mcpNameSkeleton(reserved)
    // A blank reserved entry would reduce to '' and match everything, which
    // refuses every registration on the server: an outage, not a guard.
    if (skeleton !== '' && candidate.includes(skeleton))
      return { _tag: 'Err', reason: 'reserved_client_name', matched: reserved }
  }
  return { _tag: 'Ok' }
}

/**
 * Refuse a callback whose custom scheme claims a reserved brand.
 *
 * The destination line on a consent page shows a custom-scheme callback as its
 * scheme, so `acmecloud://anything` prints the reserved word in the slot that
 * is supposed to say where the code goes. Guarding the name alone leaves this
 * open.
 */
export function assessMcpCallbackScheme(
  redirectUri: string,
  policy: Pick<McpClientIdentityPolicy, 'reservedNames'>,
): McpClientNameDecision {
  const url = readMcpUrl(redirectUri)
  if (!url || url.protocol === 'http:' || url.protocol === 'https:')
    return { _tag: 'Ok' }
  return assessMcpClientName(url.protocol.replace(/:$/, ''), policy)
}

export type McpRedirectUriDecision
  = | { _tag: 'Ok' }
    | {
      _tag: 'Err'
      reason: 'insecure_redirect_uri' | 'redirect_uri_fragment' | 'unparseable_redirect_uri'
      detail?: string
    }

/**
 * Refuse a callback OAuth 2.1 would not allow.
 *
 * The provider blocks only the actively dangerous schemes (`javascript:`,
 * `data:`, and friends). It does NOT require https for a non-loopback callback
 * and does not reject a fragment, so a registered `http://attacker.example/cb`
 * carries authorization codes in cleartext. Loopback http stays allowed: that
 * is how every desktop MCP client works, per RFC 8252.
 */
export function assessMcpRedirectUri(
  redirectUri: string,
  policy: Pick<McpClientIdentityPolicy, 'allowInsecureRedirectUri'> = {},
): McpRedirectUriDecision {
  const url = readMcpUrl(redirectUri)
  if (!url)
    return { _tag: 'Err', reason: 'unparseable_redirect_uri' }
  // RFC 6749 §3.1.2: a redirect URI must not carry a fragment, because the
  // fragment is where an implicit-flow token would land.
  if (url.hash !== '')
    return { _tag: 'Err', reason: 'redirect_uri_fragment' }
  if (url.protocol === 'http:' && !isLoopbackUrl(url) && policy.allowInsecureRedirectUri !== true)
    return { _tag: 'Err', reason: 'insecure_redirect_uri', detail: url.host }
  return { _tag: 'Ok' }
}

/**
 * The callback destination, as a human reads it on a consent page.
 *
 * ESCAPE THIS BEFORE RENDERING. The return is registrant-controlled: for an
 * unparseable `redirect_uri` it is the raw claimed string, because showing
 * something wrong is recoverable and showing nothing where the destination
 * belongs is the failure the line exists to prevent. Interpolating it into
 * HTML unescaped is stored XSS on the one page that holds the CSRF token and
 * the approve button.
 *
 * A loopback callback is labelled rather than printed: `127.0.0.1` reads as
 * suspicious to a user, and "this computer" is what it actually means.
 */
export function describeMcpCallbackDestination(redirectUri: string): string {
  const url = readMcpUrl(redirectUri)
  if (!url)
    return redirectUri
  if (isLoopbackUrl(url) && url.protocol === 'http:')
    return 'this computer'
  // A custom scheme has no meaningful host. Qualify it, so the scheme is not
  // mistaken for a brand endorsement; `assessMcpCallbackScheme` refuses a
  // reserved word here, but an unreserved one still must not read as trusted.
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return `the ${url.protocol.replace(/:$/, '')} app on this computer`
  return url.host
}

/** True for the native loopback callback a desktop MCP client listens on. */
export function isMcpLoopbackCallback(redirectUri: string): boolean {
  const url = readMcpUrl(redirectUri)
  return url !== null && url.protocol === 'http:' && isLoopbackUrl(url)
}

/**
 * True for a loopback URL, by host only.
 *
 * The whole `127.0.0.0/8` range, matching RFC 8252 §7.3 and the provider's own
 * `isLoopbackUri`. A narrower check disagreed with the provider: it treats
 * `http://127.0.0.2:5173/cb` as loopback and matches any port on it, while a
 * `127.0.0.1`-only rule renders that callback as a bare literal host.
 */
export function isMcpLoopbackUrl(url: URL | null): url is URL {
  return url !== null && isLoopbackUrl(url)
}

function isLoopbackUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host === '[::1]')
    return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/** Parse, or `null`. Never throws, so every caller can stay decision-shaped. */
export function readMcpUrl(value: string): URL | null {
  if (!URL.canParse(value))
    return null
  return new URL(value)
}

function readMcpUrlHost(value: string): string | null {
  return readMcpUrl(value)?.hostname.toLowerCase() ?? null
}
