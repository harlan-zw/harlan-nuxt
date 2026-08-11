/** Runtime entry kinds measured across the client and server bundle passes. */
export type BudgetScope = 'client' | 'client-middleware' | 'nitro' | 'nitro-middleware'
export type BudgetBundle = 'client' | 'server'

interface ScopeMeta {
  /** What one target of this scope is called. */
  noun: string
  /** What multiple targets of this scope are called. */
  plural: string
  /** The bundle the measurement came from. */
  bundle: BudgetBundle
  /** What the target's own bytes are, as opposed to what it pulls in. */
  own: string
}

export const SCOPE = {
  'client': { noun: 'Nuxt plugin', plural: 'Nuxt plugins', bundle: 'client', own: 'the plugin file' },
  'client-middleware': { noun: 'Nuxt middleware', plural: 'Nuxt middleware', bundle: 'client', own: 'the middleware file' },
  'nitro': { noun: 'Nitro plugin', plural: 'Nitro plugins', bundle: 'server', own: 'the plugin file' },
  'nitro-middleware': { noun: 'Nitro middleware', plural: 'Nitro middleware', bundle: 'server', own: 'the middleware file' },
} as const satisfies Record<BudgetScope, ScopeMeta>

export const BUDGET_SCOPES = Object.keys(SCOPE) as BudgetScope[]

export function isBudgetScope(value: unknown): value is BudgetScope {
  return typeof value === 'string' && value in SCOPE
}
