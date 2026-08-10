import { describe, expect, it } from 'vitest'
// Imported from the CLI entry (not render.ts): the dashboard renderer lives there
// so rollup retains it in the bundle. The entry guards `runMain`, so importing it
// here has no side effect.
import { formatMs, renderWorkerDashboard } from '../src/cli/index'

// Colour is disabled when not a TTY (vitest), so assertions match plain text.

describe('formatMs', () => {
  it('renders sub-second, second, and null durations', () => {
    expect(formatMs(142)).toBe('142ms')
    expect(formatMs(1200)).toBe('1.2s')
    expect(formatMs(45_000)).toBe('45s')
    expect(formatMs(null)).toBe('—')
  })
})

describe('renderWorkerDashboard', () => {
  const nowSeconds = 1_700_000_000
  const base = {
    host: 'localhost:3030',
    uptimeSeconds: 133,
    nowSeconds,
    sessionProcessed: 142,
    ratePerSec: 6,
    inflight: { crawl: 2 },
    snapshot: [
      { queue: 'crawl', ready: 0, reserved: 2, delayed: 0, completed: 84, failed: 1, maxConcurrency: 4, maxBatchSize: 10 },
      { queue: 'reports', ready: 3, reserved: 0, delayed: 1, completed: 18, failed: 0, maxConcurrency: 1, maxBatchSize: 10 },
    ],
    recent: [
      { id: 's_abc12', type: 'crawl/site-scan', queue: 'crawl', outcome: 'completed' as const, durationMs: 142, error: null, at: nowSeconds - 12 },
      { id: 'r_99x', type: 'reports/weekly', queue: 'reports', outcome: 'failed' as const, durationMs: null, error: 'timeout\nat foo', at: nowSeconds - 120 },
    ],
  }

  it('renders the status bar with host, uptime, totals and rate', () => {
    const out = renderWorkerDashboard(base)
    expect(out).toContain('cf-jobs work')
    expect(out).toContain('localhost:3030')
    expect(out).toContain('up 2m')
    expect(out).toContain('142 done')
    expect(out).toContain('1 failed') // crawl's 1 failed
    expect(out).toContain('~6/s')
  })

  it('renders per-queue lanes and a recent table with relative time', () => {
    const out = renderWorkerDashboard(base)
    expect(out).toContain('QUEUE')
    expect(out).toContain('LANES')
    expect(out).toContain('2/4') // crawl: 2 in-flight lanes of its budget 4
    expect(out).toContain('crawl/site-scan')
    expect(out).toContain('142ms')
    // recent is a real table with an AGO column showing relative time
    expect(out).toContain('AGO')
    expect(out).toContain('12s ago')
    expect(out).toContain('2m ago')
    expect(out).toContain('reports/weekly')
    expect(out).toContain('timeout')
    expect(out).not.toContain('at foo') // multi-line error trimmed to the first line
  })

  it('shows placeholders when nothing has run yet', () => {
    const out = renderWorkerDashboard({ ...base, snapshot: [], recent: [] })
    expect(out).toContain('no durable jobs yet')
    expect(out).toContain('(nothing yet)')
  })
})
