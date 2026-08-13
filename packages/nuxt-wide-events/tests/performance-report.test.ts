import type { PerformanceRun } from '../bench/ci/report.mjs'
import { describe, expect, it } from 'vitest'
import { renderPerformanceReport } from '../bench/ci/report.mjs'

const base = {
  benches: [
    { id: 'five-cpu', name: 'Five Fields serialized CPU', kind: 'time', value: 1, rme: 0.5 },
    { id: 'five-alloc', name: 'Five Fields serialized allocation', kind: 'alloc', value: 1_000 },
    { id: 'nitro-gzip', name: 'Nitro production contribution', kind: 'size', value: 1_200 },
  ],
} satisfies PerformanceRun

describe('performance report', () => {
  it('separates real changes from measurement noise', () => {
    const report = renderPerformanceReport(base, {
      benches: [
        { id: 'five-cpu', name: 'Five Fields serialized CPU', kind: 'time', value: 1.03, rme: 0.5 },
        { id: 'five-alloc', name: 'Five Fields serialized allocation', kind: 'alloc', value: 1_064 },
        { id: 'nitro-gzip', name: 'Nitro production contribution', kind: 'size', value: 1_100 },
      ],
    }, 'main @ abc1234')

    expect(report).toContain('1 regression · 1 improvement')
    expect(report).toContain('| **Five Fields serialized allocation** | 1000 B → 1.04 KiB | 🔴 +64 B (+6.4%) |')
    expect(report).toContain('| **Nitro production contribution** | 1.17 KiB → 1.07 KiB | 🟢 -100 B (-8.3%) |')
    expect(report).toContain('| Five Fields serialized CPU | 1.03 ms | ~ noise | ±0.5% |')
    expect(report).toContain('Baseline: main @ abc1234')
  })

  it('marks measurements without a base run as a new baseline', () => {
    const report = renderPerformanceReport(null, {
      benches: [
        { id: 'five-cpu', name: 'Five Fields serialized CPU', kind: 'time', value: 1, rme: 0.5 },
      ],
    }, 'main @ abc1234')

    expect(report).toContain('🆕 **1 new baseline measurement**')
    expect(report).toContain('| Five Fields serialized CPU | 1.00 ms | 🆕 new | ±0.5% |')
  })
})
