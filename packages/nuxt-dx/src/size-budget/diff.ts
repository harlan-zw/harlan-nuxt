import type { BudgetBundle, BudgetScope } from './scope'
import type { SizeBudgetSnapshot, SnapshotEntry } from './snapshot'
import { BUDGET_SCOPES, SCOPE } from './scope'
import { entryKey } from './snapshot'

export type ChangeKind = 'added' | 'removed' | 'grown' | 'shrunk' | 'unchanged'

export interface EntryChange {
  key: string
  scope: BudgetScope
  /** How the target is named in the report: its name when it has one, otherwise its path. */
  label: string
  /** Nuxt module that registered this runtime entry, when known. */
  owner?: string
  kind: ChangeKind
  /** Total bundled bytes in the base build; zero when the target is new. */
  baseBytes: number
  /** Total bundled bytes in the head build; zero when the target is gone. */
  headBytes: number
  deltaBytes: number
}

export interface ScopeTotal {
  scope: BudgetScope
  baseBytes: number
  headBytes: number
  deltaBytes: number
}

export interface BundleTotal {
  bundle: BudgetBundle
  baseBytes: number
  headBytes: number
  deltaBytes: number
}

export interface SnapshotDiff {
  /** Every target in either build, biggest growth first. */
  changes: EntryChange[]
  /** One total per runtime entry kind, in declaration order. */
  scopeTotals: ScopeTotal[]
  /** One disjoint total for each bundle. */
  bundleTotals: BundleTotal[]
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

function total(entries: readonly SnapshotEntry[], scope: BudgetScope): number {
  return entries.reduce((sum, entry) => sum + (entry.scope === scope ? entry.totalBytes : 0), 0)
}

function scopeTotals(base: SizeBudgetSnapshot, head: SizeBudgetSnapshot): ScopeTotal[] {
  const present = BUDGET_SCOPES.filter(scope => [...base.entries, ...head.entries].some(entry => entry.scope === scope))
  return present.map((scope) => {
    const baseBytes = total(base.entries, scope)
    const headBytes = total(head.entries, scope)
    return { scope, baseBytes, headBytes, deltaBytes: headBytes - baseBytes }
  })
}

function bundleTotal(entries: readonly SnapshotEntry[], bundle: BudgetBundle): number {
  return entries.reduce((sum, entry) => sum + (SCOPE[entry.scope].bundle === bundle ? entry.totalBytes : 0), 0)
}

function bundleTotals(base: SizeBudgetSnapshot, head: SizeBudgetSnapshot): BundleTotal[] {
  const entries = [...base.entries, ...head.entries]
  const present = (['client', 'server'] as const).filter(bundle => entries.some(entry => SCOPE[entry.scope].bundle === bundle))
  return present.map((bundle) => {
    const baseBytes = bundleTotal(base.entries, bundle)
    const headBytes = bundleTotal(head.entries, bundle)
    return { bundle, baseBytes, headBytes, deltaBytes: headBytes - baseBytes }
  })
}

/**
 * Pairs two reports by target identity and charges the difference. A target that
 * disappeared counts as its whole size shrinking away, one that appeared as its whole
 * size growing, so within a scope the per-target deltas add up to that scope's change.
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
      owner: identity.owner,
      kind: kindOf(before, after, deltaBytes),
      baseBytes,
      headBytes,
      deltaBytes,
    })
  }
  changes.sort((a, b) => b.deltaBytes - a.deltaBytes || a.label.localeCompare(b.label))

  return {
    changes,
    scopeTotals: scopeTotals(base, head),
    bundleTotals: bundleTotals(base, head),
    thresholdBytes,
    // Per target, never cumulative: the check is aimed at the one plugin that doubled,
    // not at a bundle drifting up by a kilobyte in twenty places.
    breaches: changes.filter(change => change.deltaBytes > thresholdBytes),
  }
}
