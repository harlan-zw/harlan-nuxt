import type { OutputBundle, Plugin } from 'rollup'
import type { GraphModule, PluginMeasurement } from './graph'
import type { BudgetScope } from './report'
import { measurePluginCost } from './graph'
import { matchTargetId } from './match'

export interface MeasuredPlugin {
  /** Absolute path to the plugin file, as Nuxt or Nitro resolved it. */
  path: string
  measurement: PluginMeasurement
}

export interface SizeBudgetPluginOptions {
  scope: BudgetScope
  /** Read lazily so plugins registered after this rollup plugin is created are included. */
  paths: () => readonly string[]
  onMeasured: (measured: readonly MeasuredPlugin[]) => void | Promise<void>
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
 * Measures the bundled weight of each plugin once the graph is final, so the cost
 * reflects post-tree-shaking bytes rather than what the source file imports on paper.
 */
export function sizeBudgetRollupPlugin(options: SizeBudgetPluginOptions): Plugin {
  return {
    name: `nuxt-dx:size-budget:${options.scope}`,
    async generateBundle(_outputOptions, bundle) {
      const paths = options.paths()
      if (!paths.length)
        return

      const { modules, entryIds } = collectGraph(bundle, id => this.getModuleInfo(id)?.importedIds ?? [])
      const ids = modules.map(module => module.id)
      const pathById = new Map<string, string>()
      for (const path of paths) {
        const id = matchTargetId(path, ids)
        if (id)
          pathById.set(id, path)
      }
      if (!pathById.size)
        return

      const measurements = measurePluginCost({ modules, targetIds: [...pathById.keys()], entryIds })
      await options.onMeasured(measurements.map(measurement => ({
        path: pathById.get(measurement.id)!,
        measurement,
      })))
    },
  }
}
