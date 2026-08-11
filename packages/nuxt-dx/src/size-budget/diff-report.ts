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

function summary(diff: SnapshotDiff): string {
  const { baseTotalBytes, headTotalBytes, totalDeltaBytes, changes } = diff
  const moved = changes.filter(change => change.kind !== 'unchanged').length
  return `${formatBytes(baseTotalBytes)} to ${formatBytes(headTotalBytes)}, **${formatDelta(totalDeltaBytes)}** across ${moved} target${moved === 1 ? '' : 's'}.`
}

function verdict(diff: SnapshotDiff): string {
  const { breaches, thresholdBytes } = diff
  const limit = formatBytes(thresholdBytes)
  if (!breaches.length)
    return `No target grew past the ${limit} threshold.`
  const named = breaches.map(change => `\`${cell(change.label)}\` ${formatDelta(change.deltaBytes)}`).join(', ')
  return `**${breaches.length} target${breaches.length === 1 ? '' : 's'} grew past the ${limit} threshold:** ${named}.`
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
  lines.push(summary(diff), '', verdict(diff), '')
  if (moved.length) {
    lines.push(
      '| Target | Scope | Base | Head | Change |',
      '| --- | --- | --- | --- | --- |',
      ...moved.map(row),
      '',
    )
  }

  const unchanged = diff.changes.length - moved.length
  lines.push(`<sub>${unchanged} target${unchanged === 1 ? '' : 's'} unchanged. Each target is charged its own bundled bytes plus every module it alone pulls in, so a plugin shipped by a module is counted under both.</sub>`)
  return lines.join('\n')
}

/** One coloured line for the terminal, so a local run says what happened without reading markdown. */
export function formatDiffVerdict(diff: SnapshotDiff): string {
  const limit = formatBytes(diff.thresholdBytes)
  if (!diff.breaches.length)
    return colors.green(`✔ nothing grew past the ${limit} threshold`) + colors.dim(` (${formatDelta(diff.totalDeltaBytes)} in total)`)
  const named = diff.breaches.map(change => `${change.label} ${formatDelta(change.deltaBytes)}`).join(', ')
  return colors.red(`✖ ${diff.breaches.length} target${diff.breaches.length === 1 ? '' : 's'} grew past the ${limit} threshold: `) + named
}
