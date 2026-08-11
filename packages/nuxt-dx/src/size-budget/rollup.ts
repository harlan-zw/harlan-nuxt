import type { OutputBundle, Plugin } from 'rollup'
import type { CostMeasurement, GraphModule } from './graph'
import type { BudgetScope } from './scope'
import type { BudgetTarget } from './targets'
import { measureCost } from './graph'

export interface MeasuredTarget {
  scope: BudgetScope
  /** Absolute path to the runtime entry, as Nuxt or Nitro resolved it. */
  path: string
  name?: string
  owner?: string
  measurement: CostMeasurement
}

export interface SizeBudgetPluginOptions {
  /** Distinguishes the client and server Rollup plugin instances. */
  name: string
  /** Restrict a shared Vite plugin to one environment. Rollup builds leave this unset. */
  environment?: string
  /** Read lazily so runtime entries registered after this Rollup plugin is created are included. */
  targets: (moduleIds: readonly string[]) => readonly BudgetTarget[]
  onMeasured: (measured: readonly MeasuredTarget[]) => void | Promise<void>
}

interface EnvironmentPlugin extends Plugin {
  applyToEnvironment?: (environment: { name: string }) => boolean
}

function collectGraph(bundle: OutputBundle, importedIdsOf: (id: string) => readonly string[]) {
  const modules: GraphModule[] = []
  const entryIds: string[] = []
  for (const output of Object.values(bundle)) {
    if (output.type !== 'chunk')
      continue
    if ((output.isEntry || output.isDynamicEntry) && output.facadeModuleId)
      entryIds.push(output.facadeModuleId)
    for (const [id, rendered] of Object.entries(output.modules))
      modules.push({ id, bytes: rendered.renderedLength ?? 0, importedIds: importedIdsOf(id) })
  }
  return { modules, entryIds }
}

/**
 * Measures the bundled weight of each target once the graph is final, so the cost
 * reflects post-tree-shaking bytes rather than what the source file imports on paper.
 */
export function sizeBudgetRollupPlugin(options: SizeBudgetPluginOptions): EnvironmentPlugin {
  return {
    name: `nuxt-dx:size-budget:${options.name}`,
    applyToEnvironment: options.environment === undefined
      ? undefined
      : environment => environment.name === options.environment,
    async generateBundle(_outputOptions, bundle) {
      const { modules, entryIds } = collectGraph(bundle, id => this.getModuleInfo(id)?.importedIds ?? [])
      const targets = options.targets(modules.map(module => module.id))
      if (!targets.length)
        return

      const byKey = new Map(targets.map(target => [target.key, target]))
      const measurements = measureCost({ modules, targets, entryIds })
      await options.onMeasured(measurements.map((measurement) => {
        const target = byKey.get(measurement.key)!
        return { scope: target.scope, path: target.path, name: target.name, owner: target.owner, measurement }
      }))
    },
  }
}
