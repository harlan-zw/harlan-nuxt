/** The three things a budget can be charged to, each measured off its own bundle pass. */
export type BudgetScope = 'client' | 'nitro' | 'modules'

interface ScopeMeta {
  /** What one target of this scope is called. */
  noun: string
  /** The bundle the measurement came from. */
  bundle: string
  /** What the target's own bytes are, as opposed to what it pulls in. */
  own: string
}

export const SCOPE = {
  client: { noun: 'Nuxt plugin', bundle: 'client', own: 'the plugin file' },
  nitro: { noun: 'Nitro plugin', bundle: 'server', own: 'the plugin file' },
  modules: { noun: 'Nuxt module', bundle: 'client', own: 'the module\'s own files' },
} as const satisfies Record<BudgetScope, ScopeMeta>

export const BUDGET_SCOPES = Object.keys(SCOPE) as BudgetScope[]

export function isBudgetScope(value: unknown): value is BudgetScope {
  return typeof value === 'string' && value in SCOPE
}
