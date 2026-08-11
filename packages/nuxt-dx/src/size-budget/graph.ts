export interface GraphModule {
  id: string
  /** Bytes this module contributes to the bundle after tree-shaking. */
  bytes: number
  importedIds: readonly string[]
}

export interface ModuleWeight {
  id: string
  bytes: number
}

export interface CostTarget {
  /** Identifies the target across the measurement; unique per target. */
  key: string
  /** Bundled module ids charged directly to this target. */
  ids: readonly string[]
}

export interface CostMeasurement {
  key: string
  /** Size of the target's own modules. */
  ownBytes: number
  /** Size of the modules reachable only through this target. */
  exclusiveBytes: number
  /** How many modules that covers, so the report can say what it left out. */
  exclusiveCount: number
  totalBytes: number
  heaviestDependencies: readonly ModuleWeight[]
}

interface MeasureInput {
  modules: readonly GraphModule[]
  targets: readonly CostTarget[]
  /** Bundle entry modules, used to discover what the app ships without any target. */
  entryIds: readonly string[]
  maxDependencies?: number
}

function walk(starts: readonly string[], byId: ReadonlyMap<string, GraphModule>, stopAt: ReadonlySet<string>): Set<string> {
  const visited = new Set<string>()
  const queue = starts.filter(id => !stopAt.has(id))
  while (queue.length) {
    const id = queue.pop()!
    if (visited.has(id))
      continue
    visited.add(id)
    for (const next of byId.get(id)?.importedIds ?? []) {
      if (!stopAt.has(next) && !visited.has(next))
        queue.push(next)
    }
  }
  return visited
}

/**
 * Charge each target the weight of its own modules plus every module that is reachable
 * only through it. Anything the app already reaches without passing through a target,
 * or that a second target also reaches, is shared and charged to nobody.
 *
 * A target is a group of module ids so the same attribution serves a single plugin file
 * and a whole Nuxt module package.
 *
 * This is pure measurement; budgets are applied afterwards so that only the targets
 * heavy enough to matter need their name resolved.
 */
export function measureCost(input: MeasureInput): CostMeasurement[] {
  const { modules, targets, entryIds, maxDependencies = 3 } = input
  const byId = new Map(modules.map(module => [module.id, module]))
  const present = targets
    .map(target => ({ key: target.key, ids: target.ids.filter(id => byId.has(id)) }))
    .filter(target => target.ids.length > 0)
  const owned = new Set(present.flatMap(target => target.ids))

  const sharedWithApp = walk(entryIds, byId, owned)

  const owners = new Map<string, Set<string>>()
  const reachedByTarget = new Map<string, Set<string>>()
  for (const target of present) {
    const imports = target.ids.flatMap(id => [...byId.get(id)!.importedIds])
    const reached = walk(imports, byId, owned)
    reachedByTarget.set(target.key, reached)
    for (const reachedId of reached) {
      const existing = owners.get(reachedId)
      if (existing)
        existing.add(target.key)
      else owners.set(reachedId, new Set([target.key]))
    }
  }

  return present.map(({ key, ids }) => {
    const exclusive: ModuleWeight[] = []
    for (const reachedId of reachedByTarget.get(key)!) {
      // Imports can point outside the bundle (node builtins, externals); those cost nothing here.
      const module = byId.get(reachedId)
      if (!module || sharedWithApp.has(reachedId) || owners.get(reachedId)!.size > 1)
        continue
      exclusive.push({ id: reachedId, bytes: module.bytes })
    }
    exclusive.sort((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id))

    const ownBytes = ids.reduce((total, id) => total + byId.get(id)!.bytes, 0)
    const exclusiveBytes = exclusive.reduce((total, module) => total + module.bytes, 0)
    return {
      key,
      ownBytes,
      exclusiveBytes,
      exclusiveCount: exclusive.length,
      totalBytes: ownBytes + exclusiveBytes,
      heaviestDependencies: exclusive.slice(0, maxDependencies),
    }
  })
}
