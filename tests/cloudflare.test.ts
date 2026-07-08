import type { AnalyticsEngineDataPoint } from '#cf-jobs/cloudflare'
import type { JobMetricsEvent, JobMetricsEventBase, JobRunStats } from '#cf-jobs/server'
import { describe, expect, it, vi } from 'vitest'
import {
  createAnalyticsEngineSink,
  defaultJobDataPoint,
  resolveAnalyticsEngineSink,
} from '#cf-jobs/cloudflare'
import { noopMetricsSink } from '#cf-jobs/server'

const base = {
  jobId: 'j1',
  queue: 'crawl',
  jobType: 'crawl/site',
  attempts: 2,
  batchId: 'b1',
  siteId: 's1',
  userId: 7,
} satisfies JobMetricsEventBase

function completed(stats: JobRunStats = {}): JobMetricsEvent {
  return { ...base, status: 'completed', durationMs: 4200, stats }
}
function failed(extra: { error: string, cause?: unknown }): JobMetricsEvent {
  return { ...base, status: 'failed', durationMs: null, ...extra }
}

const event: JobMetricsEvent = completed()

describe('defaultJobDataPoint', () => {
  it('uses queue as the single index, status/jobType as blobs, duration+attempts+stats as doubles', () => {
    expect(defaultJobDataPoint(completed({ rowsFetched: 10, rowsInserted: 4, d1RowsRead: 7, d1RowsWritten: 3 }))).toEqual({
      indexes: ['crawl'],
      blobs: ['crawl', 'crawl/site', 'completed', null],
      doubles: [4200, 2, 10, 4, 7, 3],
    })
  })

  it('zero-fills missing duration + unreported stats', () => {
    expect(defaultJobDataPoint(failed({ error: 'boom' }))).toEqual({
      indexes: ['crawl'],
      blobs: ['crawl', 'crawl/site', 'failed', 'boom'],
      doubles: [0, 2, 0, 0, 0, 0],
    })
  })

  it('never writes an error blob for a completed job (the union makes it unreachable)', () => {
    expect(defaultJobDataPoint(completed()).blobs).toEqual(['crawl', 'crawl/site', 'completed', null])
  })

  it('never writes the failure `cause` into a blob (blobs cap at 5120 bytes)', () => {
    const point = defaultJobDataPoint(failed({ error: 'TypeError: bad', cause: new TypeError('bad') }))
    expect(point.blobs).toEqual(['crawl', 'crawl/site', 'failed', 'TypeError: bad'])
    expect(JSON.stringify(point.blobs).length).toBeLessThan(5120)
  })
})

describe('createAnalyticsEngineSink', () => {
  it('writes a data point per event', () => {
    const writeDataPoint = vi.fn()
    createAnalyticsEngineSink({ writeDataPoint }).record(event)
    expect(writeDataPoint).toHaveBeenCalledWith(defaultJobDataPoint(event))
  })

  it('honours a custom toDataPoint', () => {
    const writeDataPoint = vi.fn()
    const toDataPoint = (e: JobMetricsEvent): AnalyticsEngineDataPoint => ({ blobs: [e.jobId] })
    createAnalyticsEngineSink({ writeDataPoint }, { toDataPoint }).record(event)
    expect(writeDataPoint).toHaveBeenCalledWith({ blobs: ['j1'] })
  })
})

describe('resolveAnalyticsEngineSink', () => {
  it('resolves a real sink when the binding is present', () => {
    const writeDataPoint = vi.fn()
    const sink = resolveAnalyticsEngineSink({ JOB_ANALYTICS: { writeDataPoint } }, { binding: 'JOB_ANALYTICS' })
    sink.record(event)
    expect(writeDataPoint).toHaveBeenCalledOnce()
  })

  it('falls back to noop when the binding is absent (unconfigured dev)', () => {
    const sink = resolveAnalyticsEngineSink({}, { binding: 'JOB_ANALYTICS' })
    expect(sink).toBe(noopMetricsSink)
    expect(() => sink.record(event)).not.toThrow()
  })

  it('falls back when the binding is malformed (no writeDataPoint)', () => {
    const sink = resolveAnalyticsEngineSink({ JOB_ANALYTICS: {} }, { binding: 'JOB_ANALYTICS' })
    expect(sink).toBe(noopMetricsSink)
  })

  it('uses a supplied fallback sink', () => {
    const record = vi.fn()
    const sink = resolveAnalyticsEngineSink(undefined, { binding: 'JOB_ANALYTICS', fallback: { record } })
    sink.record(event)
    expect(record).toHaveBeenCalledWith(event)
  })
})
