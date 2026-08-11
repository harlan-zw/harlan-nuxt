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

export interface PluginMeasurement {
  id: string
  /** Size of the plugin file itself. */
  ownBytes: number
  /** Size of the modules reachable only through this plugin. */
  exclusiveBytes: number
  /** How many modules that covers, so the report can say what it left out. */
  exclusiveCount: number
  totalBytes: number
  heaviestDependencies: readonly ModuleWeight[]
}

interface MeasureInput {
  modules: readonly GraphModule[]
  /** Bundled module ids of the plugins to measure. */
  targetIds: readonly string[]
  /** Bundle entry modules, used to discover what the app ships without any plugin. */
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
 * Charge each plugin the weight of its own module plus every module that is reachable
 * only through it. Anything the app already reaches without passing through a plugin,
 * or that a second plugin also reaches, is shared and charged to nobody.
 *
 * This is pure measurement; budgets are applied afterwards so that only the plugins
 * heavy enough to matter need their name resolved.
 */
export function measurePluginCost(input: MeasureInput): PluginMeasurement[] {
  const { modules, targetIds, entryIds, maxDependencies = 3 } = input
  const byId = new Map(modules.map(module => [module.id, module]))
  const present = targetIds.filter(id => byId.has(id))
  const targets = new Set(present)

  const sharedWithApp = walk(entryIds, byId, targets)

  const owners = new Map<string, Set<string>>()
  const reachedByTarget = new Map<string, Set<string>>()
  for (const id of present) {
    const reached = walk(byId.get(id)!.importedIds, byId, targets)
    reachedByTarget.set(id, reached)
    for (const reachedId of reached) {
      const existing = owners.get(reachedId)
      if (existing)
        existing.add(id)
      else owners.set(reachedId, new Set([id]))
    }
  }

  return present.map((id) => {
    const exclusive: ModuleWeight[] = []
    for (const reachedId of reachedByTarget.get(id)!) {
      // Imports can point outside the bundle (node builtins, externals); those cost nothing here.
      const module = byId.get(reachedId)
      if (!module || sharedWithApp.has(reachedId) || owners.get(reachedId)!.size > 1)
        continue
      exclusive.push({ id: reachedId, bytes: module.bytes })
    }
    exclusive.sort((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id))

    const ownBytes = byId.get(id)!.bytes
    const exclusiveBytes = exclusive.reduce((total, module) => total + module.bytes, 0)
    return {
      id,
      ownBytes,
      exclusiveBytes,
      exclusiveCount: exclusive.length,
      totalBytes: ownBytes + exclusiveBytes,
      heaviestDependencies: exclusive.slice(0, maxDependencies),
    }
  })
}
