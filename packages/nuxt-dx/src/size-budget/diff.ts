import type { BudgetScope } from './scope'
import type { SizeBudgetSnapshot, SnapshotEntry } from './snapshot'
import { entryKey } from './snapshot'

export type ChangeKind = 'added' | 'removed' | 'grown' | 'shrunk' | 'unchanged'

export interface EntryChange {
  key: string
  scope: BudgetScope
  /** How the target is named in the report: its name when it has one, otherwise its path. */
  label: string
  kind: ChangeKind
  /** Total bundled bytes in the base build; zero when the target is new. */
  baseBytes: number
  /** Total bundled bytes in the head build; zero when the target is gone. */
  headBytes: number
  deltaBytes: number
}

export interface SnapshotDiff {
  /** Every target in either build, biggest growth first. */
  changes: EntryChange[]
  /** Bytes attributed across every target, which counts a module's own plugin under both scopes. */
  baseTotalBytes: number
  headTotalBytes: number
  totalDeltaBytes: number
  /** The growth a single target is allowed before the diff fails. */
  thresholdBytes: number
  /** Targets that grew past the threshold, biggest first. */
  breaches: EntryChange[]
}

function label(entry: SnapshotEntry): string {
  return entry.name ?? entry.path
}

function kindOf(base: SnapshotEntry | undefined, head: SnapshotEntry | undefined, deltaBytes: number): ChangeKind {
  if (!base)
    return 'added'
  if (!head)
    return 'removed'
  if (deltaBytes > 0)
    return 'grown'
  return deltaBytes < 0 ? 'shrunk' : 'unchanged'
}

function total(entries: readonly SnapshotEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.totalBytes, 0)
}

/**
 * Pairs two reports by target identity and charges the difference. A target that
 * disappeared counts as its whole size shrinking away, one that appeared as its whole
 * size growing, so the per-target deltas always sum to the change in the bundle.
 */
export function diffSnapshots(base: SizeBudgetSnapshot, head: SizeBudgetSnapshot, thresholdBytes: number): SnapshotDiff {
  const baseByKey = new Map(base.entries.map(entry => [entryKey(entry), entry]))
  const headByKey = new Map(head.entries.map(entry => [entryKey(entry), entry]))

  const changes: EntryChange[] = []
  for (const key of new Set([...baseByKey.keys(), ...headByKey.keys()])) {
    const before = baseByKey.get(key)
    const after = headByKey.get(key)
    const identity = after ?? before!
    const baseBytes = before?.totalBytes ?? 0
    const headBytes = after?.totalBytes ?? 0
    const deltaBytes = headBytes - baseBytes
    changes.push({
      key,
      scope: identity.scope,
      label: label(identity),
      kind: kindOf(before, after, deltaBytes),
      baseBytes,
      headBytes,
      deltaBytes,
    })
  }
  changes.sort((a, b) => b.deltaBytes - a.deltaBytes || a.label.localeCompare(b.label))

  return {
    changes,
    baseTotalBytes: total(base.entries),
    headTotalBytes: total(head.entries),
    totalDeltaBytes: total(head.entries) - total(base.entries),
    thresholdBytes,
    breaches: changes.filter(change => change.deltaBytes > thresholdBytes),
  }
}
