import type { TreeItem } from 'consola/utils'
import type { PluginVerdict } from './budget'
import { colors, formatTree } from 'consola/utils'
import { formatBytes } from './size'

export type BudgetScope = 'client' | 'nitro'

const SCOPE = {
  client: { noun: 'Nuxt plugin', bundle: 'client' },
  nitro: { noun: 'Nitro plugin', bundle: 'server' },
} as const satisfies Record<BudgetScope, { noun: string, bundle: string }>

/** Rollup ids carry virtual prefixes and query suffixes that make paths unreadable in a warning. */
export function displayId(id: string, rootDir: string): string {
  const normalized = id.replace(/\\/g, '/').replace(/^\0/, '').split('?')[0]!
  const root = `${rootDir.replace(/\\/g, '/').replace(/\/$/, '')}/`
  const relative = normalized.startsWith(root) ? normalized.slice(root.length) : normalized
  const fromPackages = relative.lastIndexOf('node_modules/')
  return fromPackages === -1 ? relative : relative.slice(fromPackages + 'node_modules/'.length)
}

/** The key that would widen this plugin's budget: its name when it has one, otherwise its file. */
function overrideKey(verdict: PluginVerdict, rootDir: string): string {
  return verdict.name ?? displayId(verdict.path, rootDir)
}

function overrideSnippet(over: readonly PluginVerdict[], rootDir: string): string {
  const entries = over.map((verdict) => {
    // Round up to the next whole kB so the suggested budget actually clears the current size.
    const kilobytes = Math.ceil(verdict.measurement.totalBytes / 1024)
    return `'${overrideKey(verdict, rootDir)}': ${kilobytes}`
  })
  return `nuxtDx.sizeBudget.overridesKb = { ${entries.join(', ')} }`
}

/** Every byte charged to the plugin, so the listed sizes always sum to the reported total. */
function breakdown(verdict: PluginVerdict, rootDir: string): TreeItem[] {
  const { ownBytes, exclusiveBytes, exclusiveCount, heaviestDependencies } = verdict.measurement
  const rows: { bytes: number, label: string, muted: boolean }[] = [
    { bytes: ownBytes, label: 'the plugin file', muted: true },
    ...heaviestDependencies.map(dependency => ({
      bytes: dependency.bytes,
      label: displayId(dependency.id, rootDir),
      muted: false,
    })),
  ]

  // Never let the list look complete when it is truncated.
  const hidden = exclusiveCount - heaviestDependencies.length
  if (hidden > 0) {
    const shown = heaviestDependencies.reduce((total, dependency) => total + dependency.bytes, 0)
    rows.push({ bytes: exclusiveBytes - shown, label: `across ${hidden} more module${hidden === 1 ? '' : 's'}`, muted: true })
  }

  const width = Math.max(...rows.map(row => formatBytes(row.bytes).length))
  return rows.map(row => ({
    text: `${formatBytes(row.bytes).padStart(width)}  ${row.muted ? colors.gray(row.label) : colors.dim(row.label)}`,
  }))
}

export function formatBudgetReport(scope: BudgetScope, over: readonly PluginVerdict[], rootDir: string): string {
  const { noun, bundle } = SCOPE[scope]
  const lines = [`${over.length} ${noun}${over.length === 1 ? '' : 's'} over budget in the ${bundle} bundle`]

  for (const verdict of over) {
    const { name, path, budgetBytes, measurement } = verdict
    const file = displayId(path, rootDir)
    const overshoot = formatBytes(measurement.totalBytes - budgetBytes)
    lines.push(
      '',
      `  ${name ? `${colors.bold(name)}  ${colors.dim(file)}` : colors.bold(file)}`,
      `  ${formatBytes(measurement.totalBytes)} bundled, ${colors.red(`${overshoot} over`)} the ${formatBytes(budgetBytes)} budget`,
      formatTree(breakdown(verdict, rootDir), { prefix: '    ' }).trimEnd(),
    )
  }

  lines.push(
    '',
    colors.dim('  Defer heavy imports with `await import()`, or allow the size:'),
    `    ${colors.cyan(overrideSnippet(over, rootDir))}`,
  )
  return lines.join('\n')
}
