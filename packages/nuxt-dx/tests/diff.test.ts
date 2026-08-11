import type { SizeBudgetSnapshot, SnapshotEntry } from '../src/size-budget/snapshot'
import { describe, expect, it } from 'vitest'
import { diffSnapshots } from '../src/size-budget/diff'
import { SNAPSHOT_VERSION } from '../src/size-budget/snapshot'

function entry(partial: Partial<SnapshotEntry> & { totalBytes: number }): SnapshotEntry {
  return {
    scope: 'client',
    path: 'app/plugins/analytics.ts',
    ownBytes: 512,
    exclusiveBytes: partial.totalBytes - 512,
    ...partial,
  }
}

function snapshot(...entries: SnapshotEntry[]): SizeBudgetSnapshot {
  return { version: SNAPSHOT_VERSION, entries }
}

const KB = 1024

function changeOf(diff: ReturnType<typeof diffSnapshots>, label: string) {
  return diff.changes.find(change => change.label === label)!
}

describe('diffSnapshots', () => {
  it('reports a target that grew', () => {
    const diff = diffSnapshots(snapshot(entry({ totalBytes: 10 * KB })), snapshot(entry({ totalBytes: 50 * KB })), 20 * KB)
    expect(changeOf(diff, 'app/plugins/analytics.ts')).toMatchObject({
      kind: 'grown',
      baseBytes: 10 * KB,
      headBytes: 50 * KB,
      deltaBytes: 40 * KB,
    })
  })

  it('reports a target that shrank', () => {
    const diff = diffSnapshots(snapshot(entry({ totalBytes: 50 * KB })), snapshot(entry({ totalBytes: 10 * KB })), 20 * KB)
    expect(changeOf(diff, 'app/plugins/analytics.ts')).toMatchObject({ kind: 'shrunk', deltaBytes: -40 * KB })
  })

  it('charges a target that appeared its whole size', () => {
    const diff = diffSnapshots(snapshot(), snapshot(entry({ totalBytes: 8 * KB })), 20 * KB)
    expect(changeOf(diff, 'app/plugins/analytics.ts')).toMatchObject({ kind: 'added', baseBytes: 0, deltaBytes: 8 * KB })
  })

  it('credits a target that disappeared its whole size', () => {
    const diff = diffSnapshots(snapshot(entry({ totalBytes: 8 * KB })), snapshot(), 20 * KB)
    expect(changeOf(diff, 'app/plugins/analytics.ts')).toMatchObject({ kind: 'removed', headBytes: 0, deltaBytes: -8 * KB })
  })

  it('keeps a target that held still, marked unchanged', () => {
    const diff = diffSnapshots(snapshot(entry({ totalBytes: 8 * KB })), snapshot(entry({ totalBytes: 8 * KB })), 20 * KB)
    expect(changeOf(diff, 'app/plugins/analytics.ts')).toMatchObject({ kind: 'unchanged', deltaBytes: 0 })
  })

  it('pairs named plugins when their generated path moves', () => {
    const base = snapshot(entry({ name: 'i18n', path: 'node_modules/@nuxtjs/i18n/runtime/plugin.ts', totalBytes: 20 * KB }))
    const head = snapshot(entry({ name: 'i18n', path: '.pnpm/@nuxtjs+i18n@10/runtime/plugin.ts', totalBytes: 30 * KB }))
    expect(diffSnapshots(base, head, 20 * KB).changes).toHaveLength(1)
  })

  it('keeps the same path in two scopes apart', () => {
    const path = 'server/plugins/logger.ts'
    const base = snapshot(entry({ path, totalBytes: KB }), entry({ scope: 'nitro', path, totalBytes: KB }))
    expect(diffSnapshots(base, base, KB).changes).toHaveLength(2)
  })

  it('sums the per-target deltas into the change in that scope', () => {
    const base = snapshot(entry({ path: 'a.ts', totalBytes: 10 * KB }), entry({ path: 'b.ts', totalBytes: 10 * KB }))
    const head = snapshot(entry({ path: 'a.ts', totalBytes: 30 * KB }), entry({ path: 'c.ts', totalBytes: 5 * KB }))
    const diff = diffSnapshots(base, head, 100 * KB)
    expect(diff.scopeTotals).toEqual([{ scope: 'client', baseBytes: 20 * KB, headBytes: 35 * KB, deltaBytes: 15 * KB }])
    expect(diff.changes.reduce((sum, change) => sum + change.deltaBytes, 0)).toBe(15 * KB)
  })

  it('totals each entry kind and its disjoint bundle', () => {
    const plugin = entry({ scope: 'client', path: 'modules/telemetry/runtime/plugin.ts', totalBytes: 12 * KB })
    const middleware = entry({ scope: 'client-middleware', path: 'middleware/auth.ts', totalBytes: 4 * KB })
    const nitro = entry({ scope: 'nitro', path: 'server/plugins/audit.ts', totalBytes: 6 * KB })
    const diff = diffSnapshots(snapshot(plugin, middleware, nitro), snapshot(plugin, middleware, nitro), KB)
    expect(diff.scopeTotals.map(total => [total.scope, total.headBytes])).toEqual([
      ['client', 12 * KB],
      ['client-middleware', 4 * KB],
      ['nitro', 6 * KB],
    ])
    expect(diff.bundleTotals.map(total => [total.bundle, total.headBytes])).toEqual([
      ['client', 16 * KB],
      ['server', 6 * KB],
    ])
  })

  it('leaves out a scope neither build measured', () => {
    const diff = diffSnapshots(snapshot(entry({ totalBytes: KB })), snapshot(entry({ totalBytes: KB })), KB)
    expect(diff.scopeTotals.map(total => total.scope)).toEqual(['client'])
  })

  it('leads with the biggest growth', () => {
    const base = snapshot(entry({ path: 'a.ts', totalBytes: 10 * KB }), entry({ path: 'b.ts', totalBytes: 10 * KB }))
    const head = snapshot(entry({ path: 'a.ts', totalBytes: 12 * KB }), entry({ path: 'b.ts', totalBytes: 40 * KB }))
    expect(diffSnapshots(base, head, 100 * KB).changes.map(change => change.label)).toEqual(['b.ts', 'a.ts'])
  })
})

describe('growth threshold', () => {
  const base = snapshot(entry({ totalBytes: 10 * KB }))
  const head = snapshot(entry({ totalBytes: 20 * KB }))

  it('passes growth that lands exactly on the threshold', () => {
    expect(diffSnapshots(base, head, 10 * KB).breaches).toEqual([])
  })

  it('fails growth one byte past the threshold', () => {
    expect(diffSnapshots(base, head, 10 * KB - 1).breaches).toHaveLength(1)
  })

  it('holds a new target to the same threshold', () => {
    expect(diffSnapshots(snapshot(), head, 10 * KB).breaches).toHaveLength(1)
    expect(diffSnapshots(snapshot(), snapshot(entry({ totalBytes: 4 * KB })), 10 * KB).breaches).toEqual([])
  })

  it('never counts a shrink as a breach', () => {
    expect(diffSnapshots(head, base, 0).breaches).toEqual([])
  })

  it('flags any growth at all when the threshold is zero', () => {
    expect(diffSnapshots(base, snapshot(entry({ totalBytes: 10 * KB + 1 })), 0).breaches).toHaveLength(1)
  })

  it('judges each target on its own, not on the total', () => {
    const shrinking = snapshot(entry({ path: 'a.ts', totalBytes: 100 * KB }), entry({ path: 'b.ts', totalBytes: KB }))
    const grown = snapshot(entry({ path: 'a.ts', totalBytes: KB }), entry({ path: 'b.ts', totalBytes: 40 * KB }))
    const diff = diffSnapshots(shrinking, grown, 10 * KB)
    expect(diff.scopeTotals[0]!.deltaBytes).toBeLessThan(0)
    expect(diff.breaches.map(change => change.label)).toEqual(['b.ts'])
  })
})
