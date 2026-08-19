import type { SizeBudgetSnapshot, SnapshotEntry } from '../src/size-budget/snapshot'
import { stripAnsi } from 'consola/utils'
import { describe, expect, it } from 'vitest'
import { diffSnapshots } from '../src/size-budget/diff'
import { formatDiffMarkdown, formatDiffVerdict, formatMissingBaselineMarkdown } from '../src/size-budget/diff-report'
import { SNAPSHOT_VERSION } from '../src/size-budget/snapshot'

const KB = 1024

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

function markdown(base: SizeBudgetSnapshot, head: SizeBudgetSnapshot, thresholdBytes = 10 * KB): string {
  return formatDiffMarkdown(diffSnapshots(base, head, thresholdBytes))
}

describe('formatDiffMarkdown', () => {
  it('opens with a verdict naming the breach count and the net change', () => {
    const report = markdown(snapshot(entry({ totalBytes: 10 * KB })), snapshot(entry({ totalBytes: 50 * KB })))
    expect(report.split('\n')[2]).toBe('⚠️ **1 target past the 10 kB threshold** · net +40 kB')
  })

  it('calls a run clean when nothing moved', () => {
    const held = snapshot(entry({ totalBytes: KB }))
    expect(markdown(held, held)).toContain('✅ **No runtime entry changed size**')
  })

  it('separates growth under the threshold from a shrink', () => {
    const base = snapshot(entry({ totalBytes: 10 * KB }))
    expect(markdown(base, snapshot(entry({ totalBytes: 11 * KB })))).toContain('🟡 **1 target changed** · net +1 kB')
    expect(markdown(base, snapshot(entry({ totalBytes: 9 * KB })))).toContain('🟢 **1 target changed** · net -1 kB')
  })

  it('counts new targets beside the verdict', () => {
    const head = snapshot(entry({ path: 'a.ts', totalBytes: KB }), entry({ path: 'b.ts', totalBytes: KB }))
    expect(markdown(snapshot(), head)).toContain('· 🆕 2 new targets')
  })

  it('gives each changed target one row with both sizes, a marker and a share', () => {
    const base = snapshot(entry({ scope: 'client-middleware', path: 'middleware/auth.ts', totalBytes: 10 * KB }))
    const head = snapshot(entry({ scope: 'client-middleware', path: 'middleware/auth.ts', totalBytes: 50 * KB }))
    expect(markdown(base, head)).toContain('| `middleware/auth.ts` | Nuxt middleware | 10 kB → 50 kB | 🔴 +40 kB (+400.0%) |')
  })

  it('carries the owning module under the target rather than in its own column', () => {
    const base = snapshot(entry({ path: 'runtime/auth.ts', owner: '@nuxt/auth', totalBytes: 10 * KB }))
    const head = snapshot(entry({ path: 'runtime/auth.ts', owner: '@nuxt/auth', totalBytes: 12 * KB }))
    expect(markdown(base, head)).toContain('| `runtime/auth.ts`<br><sub>@nuxt/auth</sub> | Nuxt plugin |')
  })

  it('marks a target that appeared and one that disappeared', () => {
    const report = markdown(snapshot(entry({ path: 'gone.ts', totalBytes: 4 * KB })), snapshot(entry({ path: 'new.ts', totalBytes: 4 * KB })))
    expect(report).toContain('| `new.ts` | Nuxt plugin | 0 B → 4 kB | 🆕 new |')
    expect(report).toContain('| `gone.ts` | Nuxt plugin | 4 kB → 0 B | ⚪ gone |')
  })

  it('names the bundle each scope was measured in', () => {
    const base = snapshot(entry({ scope: 'nitro', path: 'server/plugins/queue.ts', totalBytes: KB }))
    const head = snapshot(entry({ scope: 'nitro', path: 'server/plugins/queue.ts', totalBytes: 2 * KB }))
    expect(markdown(base, head)).toContain('| `server/plugins/queue.ts` | Nitro plugin |')
  })

  it('folds bundle and scope totals away', () => {
    const plugin = entry({ scope: 'client', path: 'modules/telemetry/runtime/plugin.ts', totalBytes: 12 * KB })
    const middleware = entry({ scope: 'client-middleware', path: 'middleware/auth.ts', totalBytes: 4 * KB })
    const report = markdown(snapshot(plugin, middleware), snapshot(plugin, middleware))
    expect(report).toContain('<details><summary>Bundle totals</summary>')
    expect(report).toContain('| **Client** | 16 kB → 16 kB | +0 B |')
    expect(report).toContain('| <sub>Nuxt plugins</sub> | <sub>12 kB → 12 kB</sub> | <sub>+0 B</sub> |')
  })

  it('folds unchanged targets away instead of dropping or listing them', () => {
    const held = snapshot(entry({ path: 'a.ts', totalBytes: KB }), entry({ path: 'b.ts', totalBytes: KB }))
    const report = markdown(held, held)
    expect(report).toContain('<details><summary>2 unchanged targets</summary>')
    expect(report.indexOf('| `a.ts` |')).toBeGreaterThan(report.indexOf('<details><summary>2 unchanged'))
  })

  it('states that the threshold is per target rather than cumulative', () => {
    const report = markdown(snapshot(entry({ totalBytes: KB })), snapshot(entry({ totalBytes: 2 * KB })))
    expect(report).toContain('The threshold applies to each target on its own, not to the total.')
  })

  it('says nothing was measured when both builds are empty', () => {
    expect(markdown(snapshot(), snapshot())).toContain('Neither build measured')
  })

  it('escapes a path that would otherwise end its cell', () => {
    const base = snapshot(entry({ path: 'app/plugins/a|b.ts', totalBytes: KB }))
    expect(markdown(base, snapshot())).toContain('`app/plugins/a\\|b.ts`')
  })
})

describe('formatMissingBaselineMarkdown', () => {
  it('says which report was missing rather than reporting a false clean run', () => {
    const report = formatMissingBaselineMarkdown('base/.nuxt/dx/size-budget.json')
    expect(report).toContain('### 📦 Runtime size budget')
    expect(report).toContain('ℹ️ **No baseline to compare against**')
    expect(report).toContain('No baseline report was found at `base/.nuxt/dx/size-budget.json`')
    expect(report).not.toContain('threshold')
  })
})

describe('formatDiffVerdict', () => {
  function verdict(base: SizeBudgetSnapshot, head: SizeBudgetSnapshot): string {
    return stripAnsi(formatDiffVerdict(diffSnapshots(base, head, 10 * KB)))
  }

  it('passes with a count of what moved', () => {
    const base = snapshot(entry({ totalBytes: 10 * KB }))
    expect(verdict(base, snapshot(entry({ totalBytes: 12 * KB })))).toBe('✔ no target grew past the 10 kB threshold (1 target changed size)')
  })

  it('fails naming what grew', () => {
    const base = snapshot(entry({ totalBytes: 10 * KB }))
    expect(verdict(base, snapshot(entry({ totalBytes: 50 * KB }))))
      .toBe('✖ 1 target grew past the 10 kB threshold: app/plugins/analytics.ts +40 kB')
  })
})
