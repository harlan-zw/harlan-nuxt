import type { BudgetScope } from './scope'
import { kilobytesToBytes } from './size'

export interface KnownBudget {
  scope: BudgetScope
  /** Nuxt module that registers the entry. Matched against the owner and the path. */
  module: string
  kilobytes: number
  /** Why this entry costs more than the scope budget allows. */
  reason: string
}

/**
 * Budgets for runtime entries that are known to be heavy, and that the app installing them
 * cannot make smaller. Without these, every app copies the same override into its config,
 * and a real regression inside the module then hides behind that copy.
 *
 * A known budget only raises the scope budget. An app that sets a higher budget, or writes
 * its own override, still wins.
 */
export const KNOWN_BUDGETS = [
  {
    scope: 'nitro',
    module: '@sentry/nuxt',
    // Measured at 326 kB across the apps that carried the copied override. 400 kB leaves
    // room for a patch release of the SDK and still catches the plugin doubling in size.
    kilobytes: 400,
    reason: 'The Sentry Nitro plugin bundles the Node SDK and its OpenTelemetry instrumentation.',
  },
] as const satisfies readonly KnownBudget[]

function normalize(path: string): string {
  return path.replace(/\\/g, '/')
}

/** The known budget for a runtime entry, in bytes, or nothing when no known module owns it. */
export function knownBudgetBytes(scope: BudgetScope, subject: { path: string, owner?: string }): number | undefined {
  const path = normalize(subject.path)
  const known = KNOWN_BUDGETS.find(candidate => candidate.scope === scope
    && (candidate.module === subject.owner || path.includes(`/${candidate.module}/`)))
  return known === undefined ? undefined : kilobytesToBytes(known.kilobytes)
}
