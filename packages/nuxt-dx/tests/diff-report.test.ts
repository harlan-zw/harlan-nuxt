import type { SizeBudgetSnapshot, SnapshotEntry } from '../src/size-budget/snapshot'
import { stripAnsi } from 'consola/utils'
import { describe, expect, it } from 'vitest'
import { diffSnapshots } from '../src/size-budget/diff'
import { formatDiffMarkdown, formatDiffVerdict, formatMissingBaselineMarkdown } from '../src/size-budget/diff-report'

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
  return { version: 1, entries }
}

function markdown(base: SizeBudgetSnapshot, head: SizeBudgetSnapshot, thresholdBytes = 10 * KB): string {
  return formatDiffMarkdown(diffSnapshots(base, head, thresholdBytes))
}

describe('formatDiffMarkdown', () => {
  it('leads with what each scope gained or lost', () => {
    const report = markdown(snapshot(entry({ totalBytes: 10 * KB })), snapshot(entry({ totalBytes: 50 * KB })))
    expect(report).toContain('- **Nuxt plugins** 10 kB to 50 kB, **+40 kB**')
  })

  it('never adds two scopes together, since a module is charged for the plugins it ships', () => {
    const plugin = entry({ scope: 'client', path: 'modules/telemetry/runtime/plugin.ts', totalBytes: 12 * KB })
    const owner = entry({ scope: 'modules', name: 'telemetry', path: 'modules/telemetry', totalBytes: 12 * KB })
    const report = markdown(snapshot(plugin, owner), snapshot(plugin, owner))
    expect(report).toContain('- **Nuxt plugins** 12 kB to 12 kB, **+0 B**')
    expect(report).toContain('- **Nuxt modules** 12 kB to 12 kB, **+0 B**')
    expect(report).not.toContain('24 kB')
    expect(report).toContain('Scopes are totalled separately')
  })

  it('does not explain the scope split when only one scope was measured', () => {
    const report = markdown(snapshot(entry({ totalBytes: KB })), snapshot(entry({ totalBytes: 2 * KB })))
    expect(report).not.toContain('Scopes are totalled separately')
  })

  it('names the targets that grew past the threshold', () => {
    const report = markdown(snapshot(entry({ totalBytes: 10 * KB })), snapshot(entry({ totalBytes: 50 * KB })))
    expect(report).toContain('**1 target grew past the 10 kB threshold:** `app/plugins/analytics.ts` +40 kB.')
  })

  it('says so when everything stayed within the threshold', () => {
    const report = markdown(snapshot(entry({ totalBytes: 10 * KB })), snapshot(entry({ totalBytes: 11 * KB })))
    expect(report).toContain('No single target grew past the 10 kB threshold.')
  })

  it('states that the threshold is per target rather than cumulative', () => {
    const report = markdown(snapshot(entry({ totalBytes: KB })), snapshot(entry({ totalBytes: 2 * KB })))
    expect(report).toContain('the threshold applies to each target on its own rather than to the total')
  })

  it('gives each changed target a row with both sizes and the change', () => {
    const base = snapshot(entry({ scope: 'modules', name: '@nuxtjs/i18n', totalBytes: 10 * KB }))
    const head = snapshot(entry({ scope: 'modules', name: '@nuxtjs/i18n', totalBytes: 50 * KB }))
    expect(markdown(base, head)).toContain('| `@nuxtjs/i18n` | Nuxt module | 10 kB | 50 kB | +40 kB |')
  })

  it('marks a target that appeared and one that disappeared', () => {
    const base = snapshot(entry({ path: 'gone.ts', totalBytes: 4 * KB }))
    const head = snapshot(entry({ path: 'new.ts', totalBytes: 4 * KB }))
    const report = markdown(base, head)
    expect(report).toContain('| `new.ts` | Nuxt plugin | 0 B | 4 kB | +4 kB (new) |')
    expect(report).toContain('| `gone.ts` | Nuxt plugin | 4 kB | 0 B | -4 kB (gone) |')
  })

  it('names the bundle each scope was measured in', () => {
    const base = snapshot(entry({ scope: 'nitro', path: 'server/plugins/queue.ts', totalBytes: KB }))
    const head = snapshot(entry({ scope: 'nitro', path: 'server/plugins/queue.ts', totalBytes: 2 * KB }))
    expect(markdown(base, head)).toContain('| `server/plugins/queue.ts` | Nitro plugin |')
  })

  it('counts the targets that held still instead of listing them', () => {
    const held = snapshot(entry({ path: 'a.ts', totalBytes: KB }), entry({ path: 'b.ts', totalBytes: KB }))
    const report = markdown(held, held)
    expect(report).toContain('2 targets unchanged.')
    expect(report).not.toContain('| `a.ts` |')
  })

  it('drops the table when nothing moved', () => {
    const held = snapshot(entry({ totalBytes: KB }))
    expect(markdown(held, held)).not.toContain('| Target |')
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
    expect(report).toContain('### Bundle size budget')
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
