import type { HydrationIssue } from '../src/runtime/app/report'
import { describe, expect, it } from 'vitest'
import { parseHydrationWarning } from '../src/runtime/app/hydration'
import { formatDiagnosticReport, formatIssueLine, issueSignature, relativeSourcePath } from '../src/runtime/app/report'

const CLOCK_WARNING = `Hydration text content mismatch on[object HTMLParagraphElement]
  - rendered on server:  Rendered at 1786426149186
  - expected on client:  Rendered at 1786426150046`

function clockIssue(warning = CLOCK_WARNING): HydrationIssue {
  return {
    kind: 'hydration',
    mismatch: parseHydrationWarning(warning)!,
    component: 'DriftingClock',
    componentFile: 'app/components/DriftingClock.vue',
    trace: ['DriftingClock', 'Index', 'NuxtPage'],
  }
}

describe('diagnostic report', () => {
  it('normalizes source files relative to the configured root', () => {
    expect(relativeSourcePath('C:\\sites\\app\\pages\\index.vue', 'C:\\sites\\app')).toBe('pages/index.vue')
  })

  it('formats tagged issues for agent handoff', () => {
    expect(formatDiagnosticReport({
      url: 'http://localhost:3000/test',
      routeName: 'test',
      pageComponent: 'pages/test.vue',
      issues: [
        { kind: 'error', message: 'boom' },
        { kind: 'warning', message: 'careful' },
      ],
    })).toContain('## Errors\n### 1.\nboom')
  })

  it('reports a hydration mismatch by component, file and differing values', () => {
    const report = formatDiagnosticReport({
      url: 'http://localhost:3000/',
      routeName: 'index',
      pageComponent: 'pages/index.vue',
      issues: [clockIssue()],
    })
    expect(report).toContain('## Hydration mismatches')
    expect(report).toContain('### 1. Text mismatch in <DriftingClock>')
    expect(report).toContain('- Component file: `app/components/DriftingClock.vue`')
    expect(report).toContain('- Component chain: DriftingClock < Index < NuxtPage')
    expect(report).toContain('- DOM node: `HTMLParagraphElement`')
    expect(report).toContain('- Server rendered: ` Rendered at 1786426149186`')
    expect(report).toContain('- Client rendered: ` Rendered at 1786426150046`')
  })

  it('puts hydration mismatches ahead of errors and warnings', () => {
    const report = formatDiagnosticReport({
      url: 'http://localhost:3000/',
      routeName: 'index',
      issues: [{ kind: 'error', message: 'boom' }, clockIssue()],
    })
    expect(report.indexOf('## Hydration mismatches')).toBeLessThan(report.indexOf('## Errors'))
  })

  it('summarises a hydration mismatch for the overlay panel', () => {
    expect(formatIssueLine(clockIssue())).toBe([
      'HYDRATION Text mismatch in <DriftingClock>',
      '  file: app/components/DriftingClock.vue',
      '  on: HTMLParagraphElement',
      '  server:  Rendered at 1786426149186',
      '  client:  Rendered at 1786426150046',
    ].join('\n'))
  })
})

describe('issueSignature', () => {
  it('collapses a mismatch whose values drift on every render', () => {
    const later = CLOCK_WARNING.replace('1786426150046', '1786426999999')
    expect(issueSignature(clockIssue(later))).toBe(issueSignature(clockIssue()))
  })

  it('separates two mismatches from the same component', () => {
    const classWarning = `Hydration class mismatch on[object HTMLSpanElement]
  - rendered on server: class="warm"
  - expected on client: class="cool"`
    expect(issueSignature(clockIssue(classWarning))).not.toBe(issueSignature(clockIssue()))
  })

  it('keeps errors and warnings with the same text apart', () => {
    expect(issueSignature({ kind: 'error', message: 'boom' })).not.toBe(issueSignature({ kind: 'warning', message: 'boom' }))
  })
})
