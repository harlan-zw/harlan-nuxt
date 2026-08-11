import type { Nuxt } from '@nuxt/schema'
import type { BudgetOverride, PluginVerdict } from './size-budget/budget'
import type { BudgetScope } from './size-budget/report'
import type { MeasuredPlugin } from './size-budget/rollup'
import { readFile } from 'node:fs/promises'
import { addPlugin, createResolver, defineNuxtModule, useLogger } from '@nuxt/kit'
import { budgetFor, smallestBudget } from './size-budget/budget'
import { extractPluginName } from './size-budget/plugin-name'
import { formatBudgetReport } from './size-budget/report'
import { sizeBudgetRollupPlugin } from './size-budget/rollup'
import { kilobytesToBytes } from './size-budget/size'

export interface SizeBudgetOptions {
  /**
   * Kilobyte budget for each Nuxt app plugin in the client bundle. `false` disables the check.
   * @default 20
   */
  pluginsKb?: number | false
  /**
   * Kilobyte budget for each Nitro plugin in the server bundle. `false` disables the check.
   * @default 50
   */
  nitroPluginsKb?: number | false
  /** Per-plugin kilobyte budgets, keyed by plugin name or by any fragment of the plugin path. */
  overridesKb?: Record<string, number>
  /**
   * Fail the build instead of warning.
   * @default false
   */
  fail?: boolean
}

export interface ModuleOptions {
  enabled?: boolean
  position?: 'bottom-left' | 'bottom-right'
  sourceRoot?: string
  /** Warn when a plugin's exclusive import graph exceeds a bundle size budget. */
  sizeBudget?: SizeBudgetOptions | false
}

interface ResolvedBudgets {
  client: number | undefined
  nitro: number | undefined
  overrides: BudgetOverride[]
  fail: boolean
}

const logger = useLogger('nuxt-dx')

function resolveBudgets(options: SizeBudgetOptions): ResolvedBudgets {
  const resolve = (kilobytes: number | false | undefined, fallback: number, label: string) => {
    if (kilobytes === false)
      return undefined
    if (kilobytes === undefined)
      return kilobytesToBytes(fallback)
    // A negative or NaN budget would flag every plugin, so drop it rather than drown the build in warnings.
    if (!Number.isFinite(kilobytes) || kilobytes < 0) {
      logger.warn(`Ignoring \`sizeBudget.${label}\`: expected a non-negative number of kilobytes, received ${kilobytes}`)
      return undefined
    }
    return kilobytesToBytes(kilobytes)
  }

  const overrides: ResolvedBudgets['overrides'] = []
  for (const [fragment, kilobytes] of Object.entries(options.overridesKb ?? {})) {
    if (!Number.isFinite(kilobytes) || kilobytes < 0)
      logger.warn(`Ignoring \`sizeBudget.overridesKb['${fragment}']\`: expected a non-negative number of kilobytes, received ${kilobytes}`)
    else overrides.push({ fragment, bytes: kilobytesToBytes(kilobytes) })
  }

  return {
    client: resolve(options.pluginsKb, 20, 'pluginsKb'),
    nitro: resolve(options.nitroPluginsKb, 50, 'nitroPluginsKb'),
    overrides,
    fail: options.fail ?? false,
  }
}

async function readPluginName(src: string, nuxt: Nuxt): Promise<string | undefined> {
  const virtual = nuxt.vfs[src]
  if (virtual !== undefined)
    return extractPluginName(src, virtual)
  // The name is only a label, so an unreadable plugin falls back to its path rather than failing the build.
  const source = await readFile(src, 'utf-8').catch(() => undefined)
  return source === undefined ? undefined : extractPluginName(src, source)
}

/**
 * Measurement only knows paths. Names are reconciled here, once, for the plugins big
 * enough to be at risk, so a build where everything fits parses no plugin sources at all.
 */
function reporter(scope: BudgetScope, defaultBytes: number, budgets: ResolvedBudgets, nuxt: Nuxt, named: boolean) {
  const threshold = smallestBudget(defaultBytes, budgets.overrides)
  return async (measured: readonly MeasuredPlugin[]) => {
    const candidates = measured.filter(entry => entry.measurement.totalBytes > threshold)
    if (!candidates.length)
      return

    const verdicts: PluginVerdict[] = await Promise.all(candidates.map(async ({ path, measurement }) => {
      const name = named ? await readPluginName(path, nuxt) : undefined
      return { path, name, budgetBytes: budgetFor(path, name, defaultBytes, budgets.overrides), measurement }
    }))

    const over = verdicts
      .filter(verdict => verdict.measurement.totalBytes > verdict.budgetBytes)
      .sort((a, b) => b.measurement.totalBytes - a.measurement.totalBytes)
    if (!over.length)
      return

    const report = formatBudgetReport(scope, over, nuxt.options.rootDir)
    if (budgets.fail)
      throw new Error(`[nuxt-dx] ${report}`)
    logger.warn(report)
  }
}

function setupSizeBudget(options: SizeBudgetOptions, nuxt: Nuxt): void {
  const budgets = resolveBudgets(options)
  const clientBudget = budgets.client
  const nitroBudget = budgets.nitro

  if (clientBudget !== undefined) {
    // `app:resolve` runs before the client build, and holds every plugin including module-registered ones.
    let appPluginPaths: string[] = []
    nuxt.hook('app:resolve', (app) => {
      appPluginPaths = app.plugins.filter(plugin => plugin.mode !== 'server').map(plugin => plugin.src)
    })
    nuxt.hook('vite:extendConfig', (config, env) => {
      if (!env.isClient)
        return
      // `vite:extendConfig` types the config as readonly, but mutating `plugins` is the supported extension point.
      const plugins = config.plugins as unknown[] | undefined
      plugins?.push(sizeBudgetRollupPlugin({
        scope: 'client',
        paths: () => appPluginPaths,
        onMeasured: reporter('client', clientBudget, budgets, nuxt, true),
      }))
    })
  }

  if (nitroBudget !== undefined) {
    nuxt.hook('nitro:init', (nitro) => {
      nitro.hooks.hook('rollup:before', (_nitro, config) => {
        config.plugins ||= []
        ;(config.plugins as unknown[]).push(sizeBudgetRollupPlugin({
          scope: 'nitro',
          paths: () => nitro.options.plugins,
          // Nitro plugins have no name concept, so they are always identified by path.
          onMeasured: reporter('nitro', nitroBudget, budgets, nuxt, false),
        }))
      })
    })
  }
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@harlan-zw/nuxt-dx',
    configKey: 'nuxtDx',
  },
  defaults: {
    enabled: true,
    position: 'bottom-right',
  },
  setup(options, nuxt) {
    if (!options.enabled)
      return

    if (options.sizeBudget !== false)
      setupSizeBudget(options.sizeBudget ?? {}, nuxt)

    if (!nuxt.options.dev)
      return

    const publicConfig = nuxt.options.runtimeConfig.public as Record<string, unknown>
    publicConfig.nuxtDx = {
      position: options.position,
      sourceRoot: options.sourceRoot ?? nuxt.options.rootDir,
    }

    const resolver = createResolver(import.meta.url)
    addPlugin({ mode: 'client', src: resolver.resolve('./runtime/app/plugins/error-overlay.client') })
  },
})
