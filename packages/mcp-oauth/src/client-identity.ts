/**
 * Who a consent page says is asking, and where the grant actually goes.
 *
 * With open dynamic client registration the consent page IS the whole defence,
 * and `client_name` is self-declared by whoever registered. A page that shows
 * the name and nothing else renders an attacker's client identically to a real
 * one. These two rules are what make the difference visible.
 */

/**
 * Names a registering client may not claim, built from the brand words the
 * server owns.
 *
 * Callers pass words, not patterns: an operator should not have to write a
 * regular expression to protect their own name, and a caller-supplied pattern
 * is a caller-supplied backtracking risk. `['Nuxt SEO']` rejects `Nuxt SEO`,
 * `nuxtseo` and `NUXT  seo` alike.
 */
export interface McpClientNamePolicy {
  /** Brand words this server reserves. Matched case-insensitively, spacing-insensitively. */
  reservedNames: readonly string[]
}

export type McpClientNameDecision
  = | { _tag: 'Ok' }
    | { _tag: 'Err', reason: 'reserved_client_name', matched: string }

export function assessMcpClientName(
  clientName: unknown,
  policy: McpClientNamePolicy,
): McpClientNameDecision {
  // A non-string name is the provider's problem to reject, not this rule's.
  // Answering `Ok` keeps one rule doing one thing.
  if (typeof clientName !== 'string')
    return { _tag: 'Ok' }
  for (const reserved of policy.reservedNames) {
    if (reservedNamePattern(reserved).test(clientName))
      return { _tag: 'Err', reason: 'reserved_client_name', matched: reserved }
  }
  return { _tag: 'Ok' }
}

function reservedNamePattern(reserved: string): RegExp {
  const words = reserved
    .trim()
    .split(/\s+/)
    .filter(word => word.length > 0)
    .map(word => word.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
  // `\s*` between words, so collapsing or padding the spacing does not evade
  // the rule. An empty reserved entry would match everything; refuse it.
  return new RegExp(words.length > 0 ? words.join(String.raw`\s*`) : String.raw`^\b$`, 'i')
}

/**
 * The callback destination, as a human reads it on a consent page.
 *
 * The one fact that separates a real connector from a look-alike is where the
 * authorization code goes, so a consent page must show it. A loopback callback
 * is labelled rather than printed: `127.0.0.1` reads as suspicious to a user,
 * and "this computer" is what it actually means.
 */
export function describeMcpCallbackDestination(redirectUri: string): string {
  if (!URL.canParse(redirectUri))
    return redirectUri
  const url = new URL(redirectUri)
  if (isLoopbackHttp(url))
    return 'this computer'
  // A custom scheme (`cursor:`, `vscode:`) has no meaningful host, so the
  // scheme is the most honest thing to show.
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return url.protocol.replace(/:$/, '')
  return url.host
}

/** True for the native loopback callback a desktop MCP client listens on. */
export function isMcpLoopbackCallback(redirectUri: string): boolean {
  return URL.canParse(redirectUri) && isLoopbackHttp(new URL(redirectUri))
}

function isLoopbackHttp(url: URL): boolean {
  if (url.protocol !== 'http:')
    return false
  const host = url.hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}
