import { describe, expect, it } from 'vitest'
import { formatDiagnosticReport, relativeSourcePath } from '../src/runtime/app/report'

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
})
