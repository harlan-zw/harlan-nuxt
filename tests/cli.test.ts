import { describe, expect, it } from 'vitest'
import { D1ResolutionError, selectD1Database } from '../src/cli/d1'
import {
  activeJobsSql,
  backpressureSql,
  clearSql,
  failedJobsSql,
  flushSql,
  forgetSql,
  pruneSql,
  retrySql,
  sqlString,
  summarizeBackpressure,
} from '../src/cli/queries'
import { humanizeSeconds, nextCronRun, parseCron, relativeTime } from '../src/cli/render'
import { parseWranglerConfig } from '../src/wrangler'

describe('cli queries', () => {
  it('escapes single quotes when inlining strings', () => {
    expect(sqlString(`O'Brien`)).toBe(`'O''Brien'`)
    expect(activeJobsSql({ queue: `a' OR '1'='1` })).toContain(`queue = 'a'' OR ''1''=''1'`)
  })

  it('scopes backpressure to live rows and splits by state', () => {
    const sql = backpressureSql()
    expect(sql).toContain('completed_at IS NULL AND failed_at IS NULL')
    expect(sql).toContain('reserved_at IS NULL AND available_at <= unixepoch()')
    expect(sql).toContain('GROUP BY queue')
  })

  it('builds state-filtered active job listings', () => {
    expect(activeJobsSql({ state: 'reserved', limit: 10 })).toContain('reserved_at IS NOT NULL')
    expect(activeJobsSql({ state: 'delayed' })).toContain('available_at > unixepoch()')
    expect(activeJobsSql({ limit: 5 })).toContain('LIMIT 5')
  })

  it('rejects non-finite limits before they reach SQL', () => {
    expect(() => activeJobsSql({ limit: Number.NaN })).toThrow()
  })

  it('retry moves failed rows back and clears them with matching predicates', () => {
    const sql = retrySql({ id: 'job_1' })
    expect(sql).toContain(`INSERT OR IGNORE INTO jobs`)
    expect(sql).toContain(`SELECT id, queue, job_type`)
    expect(sql).toContain(`, 0, max_attempts, unixepoch(), unixepoch() FROM failed_jobs WHERE id = 'job_1'`)
    expect(sql).toContain(`DELETE FROM failed_jobs WHERE id = 'job_1'`)
  })

  it('retry requires a target', () => {
    expect(() => retrySql({})).toThrow()
    expect(() => retrySql({ all: true })).not.toThrow()
  })

  it('forget/flush/clear scope correctly', () => {
    expect(forgetSql('x')).toBe(`DELETE FROM failed_jobs WHERE id = 'x'`)
    expect(flushSql(undefined)).toBe('DELETE FROM failed_jobs')
    expect(flushSql('billing')).toBe(`DELETE FROM failed_jobs WHERE queue = 'billing'`)
    expect(clearSql({ state: 'reserved' })).toContain('reserved_at IS NOT NULL')
    expect(clearSql({})).toContain('completed_at IS NULL AND failed_at IS NULL')
  })

  it('prune deletes terminal rows past retention, jobs before batches (FK order)', () => {
    const sql = pruneSql({ completedHours: 24, failedHours: 168, batchesHours: 72 })
    expect(sql).toContain('DELETE FROM jobs WHERE completed_at IS NOT NULL AND completed_at <= unixepoch() - 86400')
    expect(sql).toContain('DELETE FROM failed_jobs WHERE failed_at <= unixepoch() - 604800')
    expect(sql).toContain('DELETE FROM job_batches WHERE finished_at IS NOT NULL AND finished_at <= unixepoch() - 259200')
    // jobs + failed_jobs pruned before job_batches (the FK target)
    expect(sql.indexOf('FROM jobs')).toBeLessThan(sql.indexOf('FROM job_batches'))
    expect(sql.indexOf('FROM failed_jobs')).toBeLessThan(sql.indexOf('FROM job_batches'))
  })

  it('honours custom table names', () => {
    const t = { jobs: 'cf_jobs', failed: 'cf_failed', batches: 'cf_batches' }
    expect(failedJobsSql({}, t)).toContain('FROM cf_failed')
    expect(backpressureSql(t)).toContain('FROM cf_jobs')
  })
})

describe('summarizeBackpressure', () => {
  const now = 1_000_000

  it('computes per-queue ready-lag and totals', () => {
    const summary = summarizeBackpressure([
      { queue: 'a', total: 5, ready: 2, reserved: 1, delayed: 2, oldest_available_at: now - 120, oldest_reserved_at: now - 30 },
      { queue: 'b', total: 1, ready: 0, reserved: 1, delayed: 0, oldest_available_at: null, oldest_reserved_at: now - 10 },
    ], now)
    expect(summary.queues[0]!.lagSeconds).toBe(120)
    expect(summary.queues[1]!.lagSeconds).toBe(0)
    expect(summary.totals).toEqual({ total: 6, ready: 2, reserved: 2, delayed: 2 })
    expect(summary.maxLagSeconds).toBe(120)
  })

  it('reports zero lag when nothing is ready', () => {
    const summary = summarizeBackpressure([
      { queue: 'a', total: 3, ready: 0, reserved: 0, delayed: 3, oldest_available_at: now - 500, oldest_reserved_at: null },
    ], now)
    expect(summary.queues[0]!.lagSeconds).toBe(0)
    expect(summary.maxLagSeconds).toBe(0)
  })
})

describe('render helpers', () => {
  it('humanizes durations', () => {
    expect(humanizeSeconds(45)).toBe('45s')
    expect(humanizeSeconds(120)).toBe('2m')
    expect(humanizeSeconds(7200)).toBe('2h')
    expect(humanizeSeconds(172_800)).toBe('2d')
  })

  it('renders relative time around now', () => {
    expect(relativeTime(1000, 1000)).toBe('now')
    expect(relativeTime(940, 1000)).toBe('1m ago')
    expect(relativeTime(1120, 1000)).toBe('in 2m')
    expect(relativeTime(null, 1000)).toBe('—')
  })
})

describe('cron parsing', () => {
  it('parses fields including steps and ranges', () => {
    const sets = parseCron('*/15 0 * * *')
    expect(sets).not.toBeNull()
    expect([...sets![0]!]).toEqual([0, 15, 30, 45])
    expect([...sets![1]!]).toEqual([0])
  })

  it('rejects malformed expressions', () => {
    expect(parseCron('* * *')).toBeNull()
    expect(parseCron('60 * * * *')).toBeNull()
    expect(parseCron('a * * * *')).toBeNull()
  })

  it('computes the next run in UTC', () => {
    // From 2026-01-01 00:00:00 UTC, "30 9 * * *" fires at 09:30 same day.
    const next = nextCronRun('30 9 * * *', new Date('2026-01-01T00:00:00Z'))
    expect(next?.toISOString()).toBe('2026-01-01T09:30:00.000Z')
  })

  it('rolls to the next day when the time has passed', () => {
    const next = nextCronRun('0 0 * * *', new Date('2026-01-01T05:00:00Z'))
    expect(next?.toISOString()).toBe('2026-01-02T00:00:00.000Z')
  })

  it('matches day-of-week with OR semantics against day-of-month', () => {
    // "0 0 1 * 1" → midnight on the 1st OR any Monday. 2026-01-05 is a Monday.
    const next = nextCronRun('0 0 1 * 1', new Date('2026-01-02T00:00:00Z'))
    expect(next?.toISOString()).toBe('2026-01-05T00:00:00.000Z')
  })
})

describe('d1 binding resolution', () => {
  it('picks the only binding when none is named', () => {
    expect(selectD1Database([{ binding: 'DB', databaseName: 'app' }]).databaseName).toBe('app')
  })

  it('requires --db when multiple bindings exist', () => {
    expect(() => selectD1Database([{ binding: 'A' }, { binding: 'B' }])).toThrow(D1ResolutionError)
  })

  it('matches a named binding', () => {
    expect(selectD1Database([{ binding: 'A' }, { binding: 'B' }], 'B').binding).toBe('B')
  })

  it('errors on unknown binding and empty config', () => {
    expect(() => selectD1Database([{ binding: 'A' }], 'Z')).toThrow(D1ResolutionError)
    expect(() => selectD1Database([])).toThrow(D1ResolutionError)
  })

  it('reads [[d1_databases]] from the toml fixture', () => {
    const config = parseWranglerConfig('tests/fixtures/wrangler-d1.toml')
    expect(config.d1Databases).toEqual([
      { binding: 'DB', databaseName: 'nuxt-cf-jobs-d1-e2e', databaseId: 'local-nuxt-cf-jobs-d1-e2e' },
    ])
  })
})
