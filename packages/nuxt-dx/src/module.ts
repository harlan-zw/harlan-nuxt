import type { Nuxt } from '@nuxt/schema'
import type { BudgetOverride, BudgetVerdict } from './size-budget/budget'
import type { ModuleOwner } from './size-budget/module-packages'
import type { MeasuredTarget } from './size-budget/rollup'
import type { BudgetScope } from './size-budget/scope'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { addPlugin, createResolver, defineNuxtModule, resolveModule, useLogger } from '@nuxt/kit'
import { budgetFor, smallestBudget } from './size-budget/budget'
import { moduleRoot } from './size-budget/module-packages'
import { extractPluginName } from './size-budget/plugin-name'
import { formatBudgetReport } from './size-budget/report'
import { sizeBudgetRollupPlugin } from './size-budget/rollup'
import { kilobytesToBytes } from './size-budget/size'
import { createSnapshotWriter, SNAPSHOT_FILE } from './size-budget/snapshot'
import { moduleTargets, pluginTargets } from './size-budget/targets'

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
  /**
   * Kilobyte budget for each Nuxt module in the client bundle. `false` disables the check.
   * @default 50
   */
  modulesKb?: number | false
  /** Per-target kilobyte budgets, keyed by plugin name, module name, or any fragment of the path. */
  overridesKb?: Record<string, number>
  /**
   * Where the machine-readable report is written, relative to the app root.
   * @default '.nuxt/dx/size-budget.json'
   */
  reportPath?: string
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
  /** Warn when a plugin's or module's exclusive import graph exceeds a bundle size budget. */
  sizeBudget?: SizeBudgetOptions | false
}

interface ResolvedBudgets {
  client: number | undefined
  nitro: number | undefined
  modules: number | undefined
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
    // A negative or NaN budget would flag everything, so drop it rather than drown the build in warnings.
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
    modules: resolve(options.modulesKb, 50, 'modulesKb'),
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
 * Measurement only knows paths. Plugin names are reconciled here, once, for the plugins big
 * enough to be at risk, so a build where everything fits parses no plugin sources at all.
 */
function reporter(scope: BudgetScope, defaultBytes: number, budgets: ResolvedBudgets, nuxt: Nuxt, named: boolean) {
  const threshold = smallestBudget(defaultBytes, budgets.overrides)
  return async (measured: readonly MeasuredTarget[]) => {
    const candidates = measured.filter(entry => entry.measurement.totalBytes > threshold)
    if (!candidates.length)
      return

    const verdicts: BudgetVerdict[] = await Promise.all(candidates.map(async (target) => {
      const { path, measurement } = target
      const name = target.name ?? (named ? await readPluginName(path, nuxt) : undefined)
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

/**
 * The file a module was loaded from. `entryPath` is whatever `modules` held, usually a bare
 * specifier, and vite resolves through symlinks, so a pnpm module's bundled ids sit under the
 * store path rather than under the link Nuxt loaded it from.
 */
function moduleEntryFile(entryPath: string, nuxt: Nuxt): string | undefined {
  let file = entryPath
  if (!isAbsolute(file)) {
    try {
      file = resolveModule(entryPath, { paths: [nuxt.options.rootDir, ...nuxt.options.modulesDir] })
    }
    catch {
      // A module Nuxt can no longer resolve cannot be matched to bundled files; leave it unattributed.
      return undefined
    }
  }
  try {
    return realpathSync(file)
  }
  catch {
    return file
  }
}

function installedModuleOwners(nuxt: Nuxt): ModuleOwner[] {
  const owners: ModuleOwner[] = []
  for (const installed of nuxt.options._installedModules ?? []) {
    // Inline and function modules have no file of their own, so nothing can be charged to them.
    if (!installed.entryPath)
      continue
    const file = moduleEntryFile(installed.entryPath, nuxt)
    if (file)
      owners.push({ name: installed.meta?.name, root: moduleRoot(file) })
  }
  return owners
}

function setupSizeBudget(options: SizeBudgetOptions, nuxt: Nuxt): void {
  const budgets = resolveBudgets(options)
  const clientBudget = budgets.client
  const nitroBudget = budgets.nitro
  const moduleBudget = budgets.modules

  const writeSnapshot = createSnapshotWriter(resolve(nuxt.options.rootDir, options.reportPath ?? SNAPSHOT_FILE), nuxt.options.rootDir)
  /**
   * Every measurement is recorded, then judged. The report covers the whole build so
   * a later run can diff it, and it is written before the verdict so a failing budget
   * still leaves the artifact behind.
   */
  const onMeasured = (scope: BudgetScope, defaultBytes: number, named: boolean) => {
    const report = reporter(scope, defaultBytes, budgets, nuxt, named)
    return async (measured: readonly MeasuredTarget[]) => {
      await writeSnapshot(scope, measured)
      await report(measured)
    }
  }

  // `app:resolve` runs before the client build, and holds every plugin including module-registered ones.
  let appPluginPaths: string[] = []
  if (clientBudget !== undefined) {
    nuxt.hook('app:resolve', (app) => {
      appPluginPaths = app.plugins.filter(plugin => plugin.mode !== 'server').map(plugin => plugin.src)
    })
  }

  if (clientBudget !== undefined || moduleBudget !== undefined) {
    nuxt.hook('vite:extendConfig', (config, env) => {
      if (!env.isClient)
        return
      // `vite:extendConfig` types the config as readonly, but mutating `plugins` is the supported extension point.
      const plugins = config.plugins as unknown[] | undefined
      if (clientBudget !== undefined) {
        plugins?.push(sizeBudgetRollupPlugin({
          scope: 'client',
          targets: ids => pluginTargets(appPluginPaths, ids),
          onMeasured: onMeasured('client', clientBudget, true),
        }))
      }
      if (moduleBudget !== undefined) {
        plugins?.push(sizeBudgetRollupPlugin({
          scope: 'modules',
          // Read at bundle time: modules keep installing while the config is assembled.
          targets: ids => moduleTargets(installedModuleOwners(nuxt), ids),
          onMeasured: onMeasured('modules', moduleBudget, false),
        }))
      }
    })
  }

  if (nitroBudget !== undefined) {
    nuxt.hook('nitro:init', (nitro) => {
      nitro.hooks.hook('rollup:before', (_nitro, config) => {
        config.plugins ||= []
        ;(config.plugins as unknown[]).push(sizeBudgetRollupPlugin({
          scope: 'nitro',
          // Nitro plugins have no name concept, so they are always identified by path.
          targets: ids => pluginTargets(nitro.options.plugins, ids),
          onMeasured: onMeasured('nitro', nitroBudget, false),
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
