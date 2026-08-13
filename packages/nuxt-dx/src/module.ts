import type { Nuxt, NuxtApp } from '@nuxt/schema'
import type { DiagnosticIssue } from './runtime/app/report'
import type { BudgetOverride, BudgetVerdict } from './size-budget/budget'
import type { ModuleOwner } from './size-budget/module-owner'
import type { MeasuredTarget } from './size-budget/rollup'
import type { BudgetScope } from './size-budget/scope'
import type { RuntimeEntry } from './size-budget/targets'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { addPlugin, addTypeTemplate, createResolver, defineNuxtModule, resolveModule, useLogger } from '@nuxt/kit'
import { budgetFor, smallestBudget } from './size-budget/budget'
import { moduleOwnerOf, moduleRoot } from './size-budget/module-owner'
import { extractPluginName } from './size-budget/plugin-name'
import { formatBudgetReport } from './size-budget/report'
import { sizeBudgetRollupPlugin } from './size-budget/rollup'
import { BUDGET_SCOPES } from './size-budget/scope'
import { kilobytesToBytes } from './size-budget/size'
import { createSnapshotWriter, resolveReportPath } from './size-budget/snapshot'
import { runtimeTargets } from './size-budget/targets'

export interface SizeBudgetOptions {
  /**
   * Kilobyte budget for each Nuxt app plugin in the client bundle. `false` disables the check.
   * @default 30
   */
  pluginsKb?: number | false
  /**
   * Kilobyte budget for each Nuxt route middleware in the client bundle. `false` disables the check.
   * @default 20
   */
  middlewareKb?: number | false
  /**
   * Kilobyte budget for each Nitro plugin in the server bundle. `false` disables the check.
   * @default 75
   */
  nitroPluginsKb?: number | false
  /**
   * Kilobyte budget for each Nitro middleware in the server bundle. `false` disables the check.
   * @default 20
   */
  nitroMiddlewareKb?: number | false
  /** Per-target kilobyte budgets, keyed by plugin name or any fragment of the path. */
  overridesKb?: Record<string, number>
  /**
   * Fail the build instead of warning.
   * @default false
   */
  fail?: boolean
}

export interface ReportOptions {
  /**
   * Where the report is written, relative to the app root.
   * @default '.nuxt/dx/size-budget.json'
   */
  path?: string
}

export interface ModuleOptions {
  enabled?: boolean
  position?: 'bottom-left' | 'bottom-right'
  sourceRoot?: string
  /** Warn when a runtime entry's exclusive import graph exceeds a bundle size budget. */
  sizeBudget?: SizeBudgetOptions | false
  /**
   * Write what the size budgets measured to a JSON file, for `nuxt-dx compare` to diff
   * against another build. Nothing is written unless you ask for it.
   * @default false
   */
  report?: boolean | ReportOptions
}

export type { DiagnosticIssue as NuxtDxIssue } from './runtime/app/report'

export interface NuxtDxRuntimeNuxtHooks {
  'nuxt-dx:issue': (issue: DiagnosticIssue) => void
}

declare module 'nuxt/app' {
  interface RuntimeNuxtHooks extends NuxtDxRuntimeNuxtHooks {}
}

interface ResolvedBudgets {
  byScope: Record<BudgetScope, number | undefined>
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
    byScope: {
      'client': resolve(options.pluginsKb, 30, 'pluginsKb'),
      'client-middleware': resolve(options.middlewareKb, 20, 'middlewareKb'),
      'nitro': resolve(options.nitroPluginsKb, 75, 'nitroPluginsKb'),
      'nitro-middleware': resolve(options.nitroMiddlewareKb, 20, 'nitroMiddlewareKb'),
    },
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
      const { path, owner, measurement } = target
      const name = target.name ?? (named ? await readPluginName(path, nuxt) : undefined)
      return { path, name, owner, budgetBytes: budgetFor(path, name, defaultBytes, budgets.overrides), measurement }
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

function runtimeEntries(scope: BudgetScope, paths: readonly string[], owners: readonly ModuleOwner[]): RuntimeEntry[] {
  return paths.map(path => ({ scope, path, owner: moduleOwnerOf(path, owners) }))
}

function setupSizeBudget(options: SizeBudgetOptions, nuxt: Nuxt, reportPath: string | undefined): void {
  const budgets = resolveBudgets(options)
  const enabledScopes = BUDGET_SCOPES.filter(scope => budgets.byScope[scope] !== undefined)

  if (reportPath !== undefined && !enabledScopes.length)
    logger.warn('`nuxtDx.report` is on, but every size budget is disabled, so there is nothing to measure.')

  const writeSnapshot = reportPath === undefined
    ? undefined
    : createSnapshotWriter(resolve(nuxt.options.rootDir, reportPath), nuxt.options.rootDir)
  /**
   * Every measurement is recorded, then judged. The report covers the whole build so
   * a later run can diff it, and it is written before the verdict so a failing budget
   * still leaves the artifact behind.
   */
  const onMeasured = (scopes: readonly BudgetScope[]) => {
    const reports = new Map(scopes.map((scope) => {
      const defaultBytes = budgets.byScope[scope]!
      return [scope, reporter(scope, defaultBytes, budgets, nuxt, scope === 'client')] as const
    }))
    return async (measured: readonly MeasuredTarget[]) => {
      for (const scope of scopes) {
        const entries = measured.filter(target => target.scope === scope)
        await writeSnapshot?.(scope, entries)
        await reports.get(scope)!(entries)
      }
    }
  }

  const clientScopes = enabledScopes.filter(scope => scope === 'client' || scope === 'client-middleware')
  // `app:resolve` holds app and module registrations before the client build starts.
  let resolvedApp: NuxtApp | undefined
  if (clientScopes.length) {
    nuxt.hook('app:resolve', (app) => {
      // Keep the object itself. Modules registered later in this hook can still mutate its arrays.
      resolvedApp = app
    })
    nuxt.hook('vite:extendConfig', (config, env) => {
      if (!env.isClient)
        return
      // `vite:extendConfig` types the config as readonly, but mutating `plugins` is the supported extension point.
      const mutableConfig = config as { plugins?: unknown[] }
      mutableConfig.plugins ||= []
      mutableConfig.plugins.push(sizeBudgetRollupPlugin({
        name: 'client',
        environment: 'client',
        targets: (ids) => {
          const owners = installedModuleOwners(nuxt)
          const entries = [
            ...(budgets.byScope.client === undefined
              ? []
              : runtimeEntries('client', resolvedApp?.plugins.filter(plugin => plugin.mode !== 'server').map(plugin => plugin.src) ?? [], owners)),
            ...(budgets.byScope['client-middleware'] === undefined
              ? []
              : runtimeEntries('client-middleware', resolvedApp?.middleware.map(middleware => middleware.path) ?? [], owners)),
          ]
          return runtimeTargets(entries, ids)
        },
        onMeasured: onMeasured(clientScopes),
      }))
    })
  }

  const nitroScopes = enabledScopes.filter(scope => scope === 'nitro' || scope === 'nitro-middleware')
  if (nitroScopes.length) {
    nuxt.hook('nitro:init', (nitro) => {
      nitro.hooks.hook('rollup:before', (_nitro, config) => {
        const owners = installedModuleOwners(nuxt)
        const middleware = [...nitro.scannedHandlers, ...nitro.options.handlers]
          .filter(handler => handler.middleware || !handler.route)
          .map(handler => handler.handler)
        const entries = [
          ...(budgets.byScope.nitro === undefined ? [] : runtimeEntries('nitro', nitro.options.plugins, owners)),
          ...(budgets.byScope['nitro-middleware'] === undefined
            ? []
            : runtimeEntries('nitro-middleware', [...new Set(middleware)], owners)),
        ]
        config.plugins ||= []
        ;(config.plugins as unknown[]).push(sizeBudgetRollupPlugin({
          name: 'server',
          targets: ids => runtimeTargets(entries, ids),
          onMeasured: onMeasured(nitroScopes),
        }))
      })
    })
  }
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@harlan-zw/nuxt-dx',
    configKey: 'nuxtDx',
    compatibility: { nuxt: '>=4.5.0 <5.0.0' },
  },
  defaults: {
    enabled: true,
    position: 'bottom-right',
  },
  setup(options, nuxt) {
    if (!options.enabled)
      return

    const reportPath = resolveReportPath(options.report)
    if (options.sizeBudget !== false)
      setupSizeBudget(options.sizeBudget ?? {}, nuxt, reportPath)
    else if (reportPath !== undefined)
      logger.warn('`nuxtDx.report` is on, but `nuxtDx.sizeBudget` is `false`, so there is nothing to measure.')

    addTypeTemplate({
      filename: 'types/nuxt-dx.d.ts',
      getContents: () => `
import type { NuxtDxRuntimeNuxtHooks } from '@harlan-zw/nuxt-dx'

declare module '#app' {
  interface RuntimeNuxtHooks extends NuxtDxRuntimeNuxtHooks {}
}

declare module 'nuxt/app' {
  interface RuntimeNuxtHooks extends NuxtDxRuntimeNuxtHooks {}
}

export {}
`,
    })

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
