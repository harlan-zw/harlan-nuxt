import type { CostTarget } from './graph'
import type { ModuleOwner } from './module-packages'
import { matchTargetId } from './match'
import { groupByOwner } from './module-packages'

export interface BudgetTarget extends CostTarget {
  /** Absolute path shown in the report. */
  path: string
  /** Display name, when it is known before measurement. */
  name?: string
}

/** One plugin file, one target. Paths that were tree-shaken out have nothing to charge. */
export function pluginTargets(paths: readonly string[], moduleIds: readonly string[]): BudgetTarget[] {
  const byId = new Map<string, BudgetTarget>()
  for (const path of paths) {
    const id = matchTargetId(path, moduleIds)
    // The same file can be registered twice; charging it twice would double the graph's owners.
    if (id && !byId.has(id))
      byId.set(id, { key: id, path, ids: [id] })
  }
  return [...byId.values()]
}

/** Every bundled file under a module's package directory is charged to that module. */
export function moduleTargets(owners: readonly ModuleOwner[], moduleIds: readonly string[]): BudgetTarget[] {
  return groupByOwner(owners, moduleIds).map(({ owner, ids }) => ({
    key: owner.name ?? owner.root,
    path: owner.root,
    name: owner.name,
    ids,
  }))
}
