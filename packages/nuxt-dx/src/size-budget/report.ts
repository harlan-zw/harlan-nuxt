import type { TreeItem } from 'consola/utils'
import type { BudgetVerdict } from './budget'
import type { BudgetScope } from './scope'
import { colors, formatTree } from 'consola/utils'
import { SCOPE } from './scope'
import { formatBytes } from './size'

/**
 * Rollup ids carry virtual prefixes and query suffixes that make paths unreadable in a
 * warning, and an absolute path pins a report to the machine that wrote it.
 *
 * `baseDir` is the workspace root, not the app root, because a monorepo app registers
 * runtime entries from sibling layers and workspace packages that sit above it. Stripping
 * only the app root leaves those entries absolute, and two checkouts at different prefixes
 * then pair with nothing: every entry reads as added, every baseline entry as removed.
 * Anything outside the workspace keeps its absolute path, which is honest about being
 * machine-specific and stays a substring of the path an override fragment matches against.
 */
export function displayId(id: string, baseDir: string): string {
  const normalized = id.replace(/\\/g, '/').replace(/^\0/, '').split('?')[0]!
  const base = `${baseDir.replace(/\\/g, '/').replace(/\/$/, '')}/`
  const relative = normalized.startsWith(base) ? normalized.slice(base.length) : normalized
  const fromPackages = relative.lastIndexOf('node_modules/')
  return fromPackages === -1 ? relative : relative.slice(fromPackages + 'node_modules/'.length)
}

/** The key that would widen this budget: the name when there is one, otherwise the file. */
function overrideKey(verdict: BudgetVerdict, baseDir: string): string {
  return verdict.name ?? displayId(verdict.path, baseDir)
}

function overrideSnippet(over: readonly BudgetVerdict[], baseDir: string): string {
  const entries = over.map((verdict) => {
    // Round up to the next whole kB so the suggested budget actually clears the current size.
    const kilobytes = Math.ceil(verdict.measurement.totalBytes / 1024)
    return `'${overrideKey(verdict, baseDir)}': ${kilobytes}`
  })
  return `nuxtDx.sizeBudget.overridesKb = { ${entries.join(', ')} }`
}

/** Every byte charged to the target, so the listed sizes always sum to the reported total. */
function breakdown(scope: BudgetScope, verdict: BudgetVerdict, baseDir: string): TreeItem[] {
  const { ownBytes, exclusiveBytes, exclusiveCount, heaviestDependencies } = verdict.measurement
  const rows: { bytes: number, label: string, muted: boolean }[] = [
    { bytes: ownBytes, label: SCOPE[scope].own, muted: true },
    ...heaviestDependencies.map(dependency => ({
      bytes: dependency.bytes,
      label: displayId(dependency.id, baseDir),
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

export function formatBudgetReport(scope: BudgetScope, over: readonly BudgetVerdict[], baseDir: string): string {
  const { noun, plural, bundle } = SCOPE[scope]
  const lines = [`${over.length} ${over.length === 1 ? noun : plural} over budget in the ${bundle} bundle`]

  for (const verdict of over) {
    const { name, owner, path, budgetBytes, measurement } = verdict
    const file = displayId(path, baseDir)
    const overshoot = formatBytes(measurement.totalBytes - budgetBytes)
    const label = name && name !== file ? `${colors.bold(name)}  ${colors.dim(file)}` : colors.bold(name ?? file)
    lines.push(
      '',
      `  ${label}${owner === undefined ? '' : colors.dim(`  Nuxt module: ${owner}`)}`,
      `  ${formatBytes(measurement.totalBytes)} bundled, ${colors.red(`${overshoot} over`)} the ${formatBytes(budgetBytes)} budget`,
      formatTree(breakdown(scope, verdict, baseDir), { prefix: '    ' }).trimEnd(),
    )
  }

  lines.push(
    '',
    colors.dim('  Defer heavy imports with `await import()`, or allow the size:'),
    `    ${colors.cyan(overrideSnippet(over, baseDir))}`,
  )
  return lines.join('\n')
}
