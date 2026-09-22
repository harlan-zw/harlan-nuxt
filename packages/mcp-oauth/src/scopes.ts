/**
 * What a consent decision actually grants.
 *
 * A grant must never carry more than the client asked for. A read-only client
 * that is handed a write scope holds a credential it can mutate with, and
 * neither the client nor the user who approved it knows that. So the optional
 * scopes are intersected with the request, and the required ones must be
 * present or there is nothing worth granting.
 */
export interface McpScopePolicy {
  /** Scopes that must be requested. Without them the grant is refused. */
  readonly required: readonly string[]
  /** Scopes granted only when the client asks for them. */
  readonly optional: readonly string[]
}

export type McpScopeDecision
  = | { _tag: 'Ok', scopes: readonly string[] }
    | { _tag: 'Err', reason: 'missing_required_scope', missing: readonly string[] }

export function grantedMcpScopes(
  requested: readonly string[],
  policy: McpScopePolicy,
): McpScopeDecision {
  const asked = new Set(requested)
  const missing = policy.required.filter(scope => !asked.has(scope))
  if (missing.length > 0)
    return { _tag: 'Err', reason: 'missing_required_scope', missing }
  return {
    _tag: 'Ok',
    // Policy order, not request order, so the stored grant is stable and two
    // clients asking for the same scopes in a different order compare equal.
    // A scope listed in both halves must appear once: the granted list is
    // stored on the grant and compared, so a duplicate makes two grants for
    // the same access look different.
    scopes: [...new Set([...policy.required, ...policy.optional.filter(scope => asked.has(scope))])],
  }
}

/**
 * The refresh-token lifetime a granted scope set has actually earned.
 *
 * Intersecting `offline_access` into the granted scopes changes nothing on its
 * own: a provider mints a refresh token whenever its TTL is non-zero, without
 * consulting scope. So a user who was shown offline access as an OPTIONAL
 * permission and declined it still walks away having issued a 30-day refresh
 * token, and the consent page's promise was false.
 *
 * Returns 0 when the scope was not granted, which is the provider's own
 * "no refresh token" value. Pass it per-grant at the code exchange; that is
 * the only point where the lifetime can still be decided.
 */
export function mcpRefreshTokenTtl(
  grantedScopes: readonly string[],
  options: { ttl: number, offlineAccessScope?: string },
): number {
  const scope = options.offlineAccessScope ?? 'offline_access'
  return grantedScopes.includes(scope) ? options.ttl : 0
}
