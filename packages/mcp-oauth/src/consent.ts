import { isMcpLoopbackCallback, readMcpUrl } from './client-identity'

/**
 * Response headers a consent page must carry.
 *
 * The page holds a CSRF secret and names the account a grant will open, so it
 * must never be stored by a shared cache, and its form must be able to post
 * only to this server or the client's registered callback.
 */

export type McpConsentFormActionDecision
  = | { _tag: 'Ok', formAction: string }
    | { _tag: 'Err', reason: 'unparseable_redirect_uri' | 'unsupported_callback_scheme' }

/**
 * Custom schemes a callback may use as a CSP source.
 *
 * An allowlist rather than "whatever scheme the registrant chose". The earlier
 * version emitted the scheme for ANY non-special URL, so a registrant could
 * ask for `javascript:` or `data:` and widen `form-action` to every
 * `javascript:` target, removing the mitigation exactly when an injected form
 * would need it.
 */
const SAFE_CALLBACK_SCHEMES = new Set(['http:', 'https:'])

/** Scheme, a registrable host or a bracketed IPv6 literal, optional port. */
const SAFE_ORIGIN_PATTERN = /^https?:\/\/(?:[\w.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i

/**
 * The CSP `form-action` value for a consent page.
 *
 * `'self'` covers the consent POST. The callback origin covers the redirect
 * that follows approval. Nothing else can be a form target, so an injected
 * form cannot post the decision anywhere.
 *
 * A custom-scheme or opaque-origin callback yields `'self'` alone: it is the
 * safe floor, and the redirect after approval is a navigation rather than a
 * form post, so the desktop flow still works.
 */
export function createMcpConsentFormAction(
  redirectUri: string,
  allowedSchemes: ReadonlySet<string> = SAFE_CALLBACK_SCHEMES,
): McpConsentFormActionDecision {
  const url = readMcpUrl(redirectUri)
  if (!url)
    return { _tag: 'Err', reason: 'unparseable_redirect_uri' }
  if (!allowedSchemes.has(url.protocol))
    return { _tag: 'Ok', formAction: '\'self\'' }
  // A loopback callback varies its port per launch, and CSP has no port
  // wildcard, so the origin would pin the wrong one. `'self'` is correct
  // because `form-action` governs form submissions, not navigations, and the
  // post-approval step is a 302 the authorization server issues.
  if (isMcpLoopbackCallback(redirectUri))
    return { _tag: 'Ok', formAction: '\'self\'' }
  // A comma in a Content-Security-Policy value splits it into TWO policies,
  // and WHATWG permits `"` and `,` in a host, so a registered callback could
  // corrupt the header and silently void the allowance. Anything outside the
  // host charset falls back to the safe floor rather than being emitted.
  if (!SAFE_ORIGIN_PATTERN.test(url.origin))
    return { _tag: 'Ok', formAction: '\'self\'' }
  return { _tag: 'Ok', formAction: `'self' ${url.origin}` }
}

export function createMcpConsentCacheControl(): string {
  return 'private, no-store, no-transform'
}
