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
  required: readonly string[]
  /** Scopes granted only when the client asks for them. */
  optional: readonly string[]
}

export type McpScopeDecision
  = | { _tag: 'Ok', scopes: string[] }
    | { _tag: 'Err', reason: 'missing_required_scope', missing: string[] }

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
    scopes: [...policy.required, ...policy.optional.filter(scope => asked.has(scope))],
  }
}
