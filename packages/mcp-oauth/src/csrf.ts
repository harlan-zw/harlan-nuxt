/**
 * Consent-page secrets.
 *
 * The CSRF token and the CSP nonce must never be the same value. Double-submit
 * makes sharing one technically safe today, but it prints the CSRF secret into
 * the page source as the nonce, and two secrets with different lifetimes and
 * different threat models must not share a value.
 *
 * `createMcpConsentSecrets` is the only way to get them, which is what makes
 * the mistake unrepresentable. Two separately-named functions returning the
 * same thing did not: nothing stopped a caller computing one and using it
 * twice, which is the bug this module exists to prevent.
 */

/** 32 random bytes, base64url, no padding: 43 characters. */
export function createMcpRandomToken(
  randomBytes: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(32)),
): string {
  let binary = ''
  for (const byte of randomBytes())
    binary += String.fromCodePoint(byte)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

export interface McpConsentSecrets {
  /** Goes in the `__Host-` cookie and the form's hidden field. Never rendered elsewhere. */
  readonly csrfToken: string
  /** Goes in the CSP `style-src`/`script-src` nonce. Safe to print in the page. */
  readonly cspNonce: string
}

export function createMcpConsentSecrets(
  randomBytes?: () => Uint8Array,
): McpConsentSecrets {
  return {
    csrfToken: createMcpRandomToken(randomBytes),
    cspNonce: createMcpRandomToken(randomBytes),
  }
}

/**
 * Double-submit comparison for the consent decision.
 *
 * Both halves must be strings. Without that guard two non-strings compared
 * equal: `(1).length` is `undefined`, so the length check passed, the loop
 * body never ran, and the function reported agreement on a mismatch.
 *
 * Length first, then every character with no early return, so the comparison
 * does not leak the matching prefix through its own timing. The length itself
 * leaks, which is why the tokens are fixed-width.
 */
export function verifyMcpCsrfToken(
  cookieToken: unknown,
  submittedToken: unknown,
): boolean {
  if (typeof cookieToken !== 'string' || typeof submittedToken !== 'string')
    return false
  if (!cookieToken || !submittedToken || cookieToken.length !== submittedToken.length)
    return false
  let mismatch = 0
  for (let index = 0; index < cookieToken.length; index++)
    mismatch |= cookieToken.charCodeAt(index) ^ submittedToken.charCodeAt(index)
  return mismatch === 0
}
