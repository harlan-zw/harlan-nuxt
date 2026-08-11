import type { EntryChange, SnapshotDiff } from './diff'
import { colors } from 'consola/utils'
import { SCOPE } from './scope'
import { formatBytes, formatDelta } from './size'

const SUFFIX: Partial<Record<EntryChange['kind'], string>> = {
  added: ' (new)',
  removed: ' (gone)',
}

/** A label is a file path or a package name; either can hold the character that ends a cell. */
function cell(text: string): string {
  return text.replaceAll('|', '\\|')
}

function row(change: EntryChange): string {
  const columns = [
    `\`${cell(change.label)}\``,
    SCOPE[change.scope].noun,
    formatBytes(change.baseBytes),
    formatBytes(change.headBytes),
    `${formatDelta(change.deltaBytes)}${SUFFIX[change.kind] ?? ''}`,
  ]
  return `| ${columns.join(' | ')} |`
}

/** One line per scope. Scopes overlap, so there is no honest single number to lead with. */
function summary(diff: SnapshotDiff): string[] {
  const lines = diff.scopeTotals.map(({ scope, baseBytes, headBytes, deltaBytes }) =>
    `- **${SCOPE[scope].noun}s** ${formatBytes(baseBytes)} to ${formatBytes(headBytes)}, **${formatDelta(deltaBytes)}**`)
  if (diff.scopeTotals.length > 1)
    lines.push('', 'Scopes are totalled separately, since a Nuxt module is charged for the plugins it ships.')
  return lines
}

function verdict(diff: SnapshotDiff): string {
  const { breaches, thresholdBytes } = diff
  const limit = formatBytes(thresholdBytes)
  if (!breaches.length)
    return `No single target grew past the ${limit} threshold.`
  const named = breaches.map(change => `\`${cell(change.label)}\` ${formatDelta(change.deltaBytes)}`).join(', ')
  return `**${breaches.length} target${breaches.length === 1 ? '' : 's'} grew past the ${limit} threshold:** ${named}.`
}

/**
 * Nothing to compare against, which is the normal state of the first run on a branch and
 * of a branch whose baseline artifact has expired. Said out loud rather than passed over.
 */
export function formatMissingBaselineMarkdown(path: string): string {
  return [
    '### Bundle size budget',
    '',
    `No baseline report was found at \`${path}\`, so there is nothing to compare this build against.`,
    '',
    'This run leaves its own report behind, which the next one can measure against.',
  ].join('\n')
}

/**
 * The diff as GitHub-flavoured markdown, ready to append to a step summary. Unchanged
 * targets are counted rather than listed: a report of forty plugins that all held still
 * is noise around the one that did not.
 */
export function formatDiffMarkdown(diff: SnapshotDiff): string {
  const lines = ['### Bundle size budget', '']
  if (!diff.changes.length)
    return [...lines, 'Neither build measured a plugin, a Nitro plugin or a Nuxt module.'].join('\n')

  const moved = diff.changes.filter(change => change.kind !== 'unchanged')
  lines.push(...summary(diff), '', verdict(diff), '')
  if (moved.length) {
    lines.push(
      '| Target | Scope | Base | Head | Change |',
      '| --- | --- | --- | --- | --- |',
      ...moved.map(row),
      '',
    )
  }

  const unchanged = diff.changes.length - moved.length
  lines.push(`<sub>${unchanged} target${unchanged === 1 ? '' : 's'} unchanged. Each target is charged its own bundled bytes plus every module it alone pulls in, and the threshold applies to each target on its own rather than to the total.</sub>`)
  return lines.join('\n')
}

/** One coloured line for the terminal, so a local run says what happened without reading markdown. */
export function formatDiffVerdict(diff: SnapshotDiff): string {
  const limit = formatBytes(diff.thresholdBytes)
  if (!diff.breaches.length) {
    const moved = diff.changes.filter(change => change.kind !== 'unchanged').length
    return colors.green(`✔ no target grew past the ${limit} threshold`) + colors.dim(` (${moved} target${moved === 1 ? '' : 's'} changed size)`)
  }
  const named = diff.breaches.map(change => `${change.label} ${formatDelta(change.deltaBytes)}`).join(', ')
  return colors.red(`✖ ${diff.breaches.length} target${diff.breaches.length === 1 ? '' : 's'} grew past the ${limit} threshold: `) + named
}
