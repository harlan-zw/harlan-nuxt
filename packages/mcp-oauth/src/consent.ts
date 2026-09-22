/**
 * Response headers a consent page must carry.
 *
 * The page holds a CSRF secret and names the Team or account a grant will
 * open, so it must never be stored by a shared cache, and its form must be
 * able to post only to this server or the client's registered callback.
 */

/**
 * The CSP `form-action` value for a consent page.
 *
 * `'self'` covers the consent POST itself. The callback origin covers the
 * redirect that follows approval. Nothing else can be a form target, so an
 * injected form cannot post the decision anywhere.
 *
 * A custom-scheme callback (`cursor:`) has a `null` origin, so its scheme is
 * used instead, which is the narrowest value CSP accepts for it.
 */
export function createMcpConsentFormAction(redirectUri: string): string {
  // `redirect_uris` is client-supplied metadata (RFC 7591), so a stored
  // malformed callback degrades to `'self'` instead of crashing the render.
  if (!URL.canParse(redirectUri))
    return `'self'`
  const redirect = new URL(redirectUri)
  const callback = redirect.origin === 'null' ? redirect.protocol : redirect.origin
  return `'self' ${callback}`
}

export function createMcpConsentCacheControl(): string {
  return 'private, no-store, no-transform'
}
