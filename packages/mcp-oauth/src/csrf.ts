/**
 * Consent-page secrets.
 *
 * The CSRF token and the CSP nonce are minted separately and deliberately.
 * Double-submit makes sharing one value safe today, but it prints the CSRF
 * secret into the page source as the nonce, and two secrets with different
 * lifetimes and different threat models must not share a value.
 */

/** 32 random bytes, base64url, no padding. */
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

export const createMcpCsrfToken = createMcpRandomToken
export const createMcpCspNonce = createMcpRandomToken

/**
 * Double-submit comparison for the consent decision.
 *
 * Length first, then every character with no early return, so the comparison
 * does not leak the matching prefix through its own timing.
 */
export function verifyMcpCsrfToken(
  cookieToken: string | undefined,
  submittedToken: string | undefined,
): boolean {
  if (!cookieToken || !submittedToken || cookieToken.length !== submittedToken.length)
    return false
  let mismatch = 0
  for (let index = 0; index < cookieToken.length; index++)
    mismatch |= cookieToken.charCodeAt(index) ^ submittedToken.charCodeAt(index)
  return mismatch === 0
}
