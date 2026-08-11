import type { CostTarget } from './graph'
import type { BudgetScope } from './scope'
import { matchTargetId } from './match'

export interface RuntimeEntry {
  scope: BudgetScope
  /** Absolute path registered with Nuxt or Nitro. */
  path: string
  /** Nuxt module that registered this entry, when known. */
  owner?: string
}

export interface BudgetTarget extends CostTarget, RuntimeEntry {
  /** Absolute path shown in the report. */
  name?: string
}

/**
 * One runtime file, one target. Plugins and middleware share the same pass so a dependency
 * they both import is shared, not charged twice. Paths tree-shaken out cost nothing.
 */
export function runtimeTargets(entries: readonly RuntimeEntry[], moduleIds: readonly string[]): BudgetTarget[] {
  const byId = new Map<string, BudgetTarget>()
  for (const entry of entries) {
    const { path } = entry
    const id = matchTargetId(path, moduleIds)
    // One file can be registered twice. The first registration owns it so totals stay disjoint.
    if (id && !byId.has(id))
      byId.set(id, { key: `${entry.scope}:${id}`, ...entry, ids: [id] })
  }
  return [...byId.values()]
}
