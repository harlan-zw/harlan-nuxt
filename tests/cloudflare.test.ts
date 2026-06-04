import type { AnalyticsEngineDataPoint } from '#cf-jobs/cloudflare'
import type { JobMetricsEvent } from '#cf-jobs/server'
import { describe, expect, it, vi } from 'vitest'
import {
  createAnalyticsEngineSink,
  defaultJobDataPoint,
  resolveAnalyticsEngineSink,
} from '#cf-jobs/cloudflare'
import { noopMetricsSink } from '#cf-jobs/server'

const event: JobMetricsEvent = {
  jobId: 'j1',
  queue: 'crawl',
  jobType: 'crawl/site',
  status: 'completed',
  attempts: 2,
  durationMs: 4200,
  batchId: 'b1',
  siteId: 's1',
  userId: 7,
}

describe('defaultJobDataPoint', () => {
  it('uses queue as the single index, status/jobType as blobs, duration+attempts+stats as doubles', () => {
    expect(defaultJobDataPoint({ ...event, rowsFetched: 10, rowsInserted: 4, d1RowsRead: 7, d1RowsWritten: 3 })).toEqual({
      indexes: ['crawl'],
      blobs: ['crawl', 'crawl/site', 'completed', null],
      doubles: [4200, 2, 10, 4, 7, 3],
    })
  })

  it('zero-fills missing duration + unreported stats', () => {
    expect(defaultJobDataPoint({ ...event, status: 'failed', durationMs: null, error: 'boom' })).toEqual({
      indexes: ['crawl'],
      blobs: ['crawl', 'crawl/site', 'failed', 'boom'],
      doubles: [0, 2, 0, 0, 0, 0],
    })
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
