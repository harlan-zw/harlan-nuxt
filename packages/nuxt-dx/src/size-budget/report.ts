import type { TreeItem } from 'consola/utils'
import type { BudgetVerdict } from './budget'
import type { BudgetScope } from './scope'
import { colors, formatTree } from 'consola/utils'
import { SCOPE } from './scope'
import { formatBytes } from './size'

/** Rollup ids carry virtual prefixes and query suffixes that make paths unreadable in a warning. */
export function displayId(id: string, rootDir: string): string {
  const normalized = id.replace(/\\/g, '/').replace(/^\0/, '').split('?')[0]!
  const root = `${rootDir.replace(/\\/g, '/').replace(/\/$/, '')}/`
  const relative = normalized.startsWith(root) ? normalized.slice(root.length) : normalized
  const fromPackages = relative.lastIndexOf('node_modules/')
  return fromPackages === -1 ? relative : relative.slice(fromPackages + 'node_modules/'.length)
}

/** The key that would widen this budget: the name when there is one, otherwise the file. */
function overrideKey(verdict: BudgetVerdict, rootDir: string): string {
  return verdict.name ?? displayId(verdict.path, rootDir)
}

function overrideSnippet(over: readonly BudgetVerdict[], rootDir: string): string {
  const entries = over.map((verdict) => {
    // Round up to the next whole kB so the suggested budget actually clears the current size.
    const kilobytes = Math.ceil(verdict.measurement.totalBytes / 1024)
    return `'${overrideKey(verdict, rootDir)}': ${kilobytes}`
  })
  return `nuxtDx.sizeBudget.overridesKb = { ${entries.join(', ')} }`
}

/** Every byte charged to the target, so the listed sizes always sum to the reported total. */
function breakdown(scope: BudgetScope, verdict: BudgetVerdict, rootDir: string): TreeItem[] {
  const { ownBytes, exclusiveBytes, exclusiveCount, heaviestDependencies } = verdict.measurement
  const rows: { bytes: number, label: string, muted: boolean }[] = [
    { bytes: ownBytes, label: SCOPE[scope].own, muted: true },
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

export function formatBudgetReport(scope: BudgetScope, over: readonly BudgetVerdict[], rootDir: string): string {
  const { noun, bundle } = SCOPE[scope]
  const lines = [`${over.length} ${noun}${over.length === 1 ? '' : 's'} over budget in the ${bundle} bundle`]

  for (const verdict of over) {
    const { name, path, budgetBytes, measurement } = verdict
    const file = displayId(path, rootDir)
    const overshoot = formatBytes(measurement.totalBytes - budgetBytes)
    lines.push(
      '',
      `  ${name && name !== file ? `${colors.bold(name)}  ${colors.dim(file)}` : colors.bold(name ?? file)}`,
      `  ${formatBytes(measurement.totalBytes)} bundled, ${colors.red(`${overshoot} over`)} the ${formatBytes(budgetBytes)} budget`,
      formatTree(breakdown(scope, verdict, rootDir), { prefix: '    ' }).trimEnd(),
    )
  }

  lines.push(
    '',
    colors.dim('  Defer heavy imports with `await import()`, or allow the size:'),
    `    ${colors.cyan(overrideSnippet(over, rootDir))}`,
  )
  return lines.join('\n')
}
