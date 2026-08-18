import type { EntryChange, SnapshotDiff } from './diff'
import { colors } from 'consola/utils'
import { SCOPE } from './scope'
import { formatBytes, formatDelta } from './size'

/** Heading on every report, so a reader finds the same block in a long summary. */
const HEADING = '### 📦 Runtime size budget'

const MARKER: Partial<Record<EntryChange['kind'], string>> = {
  added: '🆕',
  removed: '⚪',
  grown: '🔴',
  shrunk: '🟢',
}

/** A label is a file path or a package name; either can hold the character that ends a cell. */
function cell(text: string): string {
  return text.replaceAll('|', '\\|')
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** Growth reads differently at 200 B and at 200 kB, so the share of the base goes beside it. */
function percent(deltaBytes: number, baseBytes: number): string {
  if (baseBytes <= 0)
    return ''
  const share = (deltaBytes / baseBytes) * 100
  return ` (${share > 0 ? '+' : '-'}${Math.abs(share).toFixed(1)}%)`
}

function deltaCell(change: EntryChange): string {
  if (change.kind === 'added')
    return '🆕 new'
  if (change.kind === 'removed')
    return '⚪ gone'
  if (change.kind === 'unchanged')
    return '—'
  return `${MARKER[change.kind]} ${formatDelta(change.deltaBytes)}${percent(change.deltaBytes, change.baseBytes)}`
}

/** The owner rides under the target rather than in its own column, to keep the table narrow. */
function targetCell(change: EntryChange): string {
  const target = `\`${cell(change.label)}\``
  return change.owner === undefined ? target : `${target}<br><sub>${cell(change.owner)}</sub>`
}

function row(change: EntryChange): string {
  const columns = [
    targetCell(change),
    SCOPE[change.scope].noun,
    `${formatBytes(change.baseBytes)} → ${formatBytes(change.headBytes)}`,
    deltaCell(change),
  ]
  return `| ${columns.join(' | ')} |`
}

function table(changes: EntryChange[]): string[] {
  return [
    '| Target | Scope | Size | Δ |',
    '| --- | --- | --- | --- |',
    ...changes.map(row),
  ]
}

/**
 * One line that answers the only question a reviewer opens the comment with: did this
 * pull request add JavaScript, and does anything need a decision.
 */
function verdict(diff: SnapshotDiff): string {
  const moved = diff.changes.filter(change => change.kind !== 'unchanged')
  const added = moved.filter(change => change.kind === 'added')
  const net = moved.reduce((total, change) => total + change.deltaBytes, 0)
  const limit = formatBytes(diff.thresholdBytes)

  const parts: string[] = []
  if (diff.breaches.length)
    parts.push(`⚠️ **${plural(diff.breaches.length, 'target')} past the ${limit} threshold** · net ${formatDelta(net)}`)
  else if (!moved.length)
    parts.push('✅ **No runtime entry changed size**')
  else if (net > 0)
    parts.push(`🟡 **${plural(moved.length, 'target')} changed** · net ${formatDelta(net)}`)
  else
    parts.push(`🟢 **${plural(moved.length, 'target')} changed** · net ${formatDelta(net)}`)

  if (added.length)
    parts.push(`🆕 ${plural(added.length, 'new target')}`)
  return parts.join(' · ')
}

/** Bundle and scope totals, folded away: they answer a follow-up question, not the first one. */
function totals(diff: SnapshotDiff): string[] {
  const rows: string[] = ['| Bundle | Size | Δ |', '| --- | --- | --- |']
  for (const { bundle, baseBytes, headBytes, deltaBytes } of diff.bundleTotals) {
    rows.push(`| **${bundle === 'client' ? 'Client' : 'Server'}** | ${formatBytes(baseBytes)} → ${formatBytes(headBytes)} | ${formatDelta(deltaBytes)} |`)
    for (const total of diff.scopeTotals.filter(total => SCOPE[total.scope].bundle === bundle))
      rows.push(`| <sub>${SCOPE[total.scope].plural}</sub> | <sub>${formatBytes(total.baseBytes)} → ${formatBytes(total.headBytes)}</sub> | <sub>${formatDelta(total.deltaBytes)}</sub> |`)
  }
  return ['<details><summary>Bundle totals</summary>', '', ...rows, '</details>']
}

/**
 * Nothing to compare against, which is the normal state of the first run on a branch,
 * of a branch whose baseline artifact has expired, and of the first run after the report
 * format changed. Said out loud rather than passed over.
 */
export function formatMissingBaselineMarkdown(path: string, reason?: string): string {
  return [
    HEADING,
    '',
    'ℹ️ **No baseline to compare against**',
    '',
    reason === undefined
      ? `No baseline report was found at \`${path}\`.`
      : `The baseline report at \`${path}\` cannot be read. ${reason}`,
    '',
    'This run leaves its own report behind, which the next one can measure against.',
  ].join('\n')
}

/**
 * The diff as GitHub-flavoured markdown, for a step summary and a pull request comment.
 * The verdict and the targets that moved carry the whole story; every unchanged target
 * sits behind a fold, because a report of forty plugins that all held still is noise
 * around the one that did not.
 */
export function formatDiffMarkdown(diff: SnapshotDiff): string {
  const lines = [HEADING, '']
  if (!diff.changes.length)
    return [...lines, 'Neither build measured a runtime entry.'].join('\n')

  const moved = diff.changes.filter(change => change.kind !== 'unchanged')
  lines.push(verdict(diff), '')
  if (moved.length)
    lines.push(...table(moved), '')
  lines.push(...totals(diff), '')

  const unchanged = diff.changes.filter(change => change.kind === 'unchanged')
  if (unchanged.length) {
    lines.push(
      `<details><summary>${plural(unchanged.length, 'unchanged target')}</summary>`,
      '',
      ...table(unchanged),
      '</details>',
      '',
    )
  }

  lines.push('<sub>Each target is charged its own bundled bytes plus every module it alone pulls in. The threshold applies to each target on its own, not to the total.</sub>')
  return lines.join('\n')
}

/** One coloured line for the terminal, so a local run says what happened without reading markdown. */
export function formatDiffVerdict(diff: SnapshotDiff): string {
  const limit = formatBytes(diff.thresholdBytes)
  if (!diff.breaches.length) {
    const moved = diff.changes.filter(change => change.kind !== 'unchanged').length
    return colors.green(`✔ no target grew past the ${limit} threshold`) + colors.dim(` (${plural(moved, 'target')} changed size)`)
  }
  const named = diff.breaches.map(change => `${change.label} ${formatDelta(change.deltaBytes)}`).join(', ')
  return colors.red(`✖ ${plural(diff.breaches.length, 'target')} grew past the ${limit} threshold: `) + named
}
