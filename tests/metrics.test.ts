import type { JobMetricsEvent } from '#cf-jobs/server'
import { describe, expect, it, vi } from 'vitest'
import {
  combineMetricsSinks,
  createConsoleMetricsSink,
  metricsSinkToRepoHooks,
  noopMetricsSink,
} from '#cf-jobs/server'

function job(over: Record<string, unknown> = {}) {
  return {
    id: 'j1',
    queue: 'crawl',
    job_type: 'crawl/site',
    attempts: 2,
    batch_id: 'b1',
    site_id: 's1',
    user_id: 7,
    duration_ms: 1234,
    ...over,
  } as never
}

describe('metricsSinkToRepoHooks', () => {
  it('maps completed/failed/released hook payloads to events', async () => {
    const events: JobMetricsEvent[] = []
    const hooks = metricsSinkToRepoHooks({ record: e => void events.push(e) })

    await hooks.onJobCompleted!({ job: job(), durationMs: 4200, result: undefined })
    await hooks.onJobFailed!({ job: job(), error: 'boom' })
    await hooks.onJobReleased!({ job: job(), opts: { error: 'rate-limited' } })

    expect(events).toEqual([
      { jobId: 'j1', queue: 'crawl', jobType: 'crawl/site', status: 'completed', attempts: 2, durationMs: 4200, batchId: 'b1', siteId: 's1', userId: 7, stats: {} },
      { jobId: 'j1', queue: 'crawl', jobType: 'crawl/site', status: 'failed', attempts: 2, durationMs: 1234, batchId: 'b1', siteId: 's1', userId: 7, error: 'boom' },
      { jobId: 'j1', queue: 'crawl', jobType: 'crawl/site', status: 'released', attempts: 2, durationMs: null, batchId: 'b1', siteId: 's1', userId: 7, error: 'rate-limited' },
    ])
  })

  it('falls back to null durationMs on completed when the payload omits it', async () => {
    const events: JobMetricsEvent[] = []
    const hooks = metricsSinkToRepoHooks({ record: e => void events.push(e) })
    await hooks.onJobCompleted!({ job: job({ duration_ms: null }), durationMs: null })
    expect(events[0]!.durationMs).toBeNull()
  })
})

describe('combineMetricsSinks', () => {
  it('fans out to every sink and isolates a throwing one', async () => {
    const a = vi.fn()
    const c = vi.fn()
    const sink = combineMetricsSinks(
      { record: a },
      { record: () => { throw new Error('bad sink') } },
      { record: c },
    )
    const event = { jobId: 'j', queue: 'q', jobType: 't', status: 'completed', attempts: 1, durationMs: 1, batchId: null, siteId: null, userId: null } as JobMetricsEvent
    await expect(sink.record(event)).resolves.toBeUndefined()
    expect(a).toHaveBeenCalledWith(event)
    expect(c).toHaveBeenCalledWith(event) // reached despite the middle sink throwing
  })

  it('swallows an async sink rejection', async () => {
    const sink = combineMetricsSinks({ record: () => Promise.reject(new Error('async boom')) })
    await expect(sink.record({} as JobMetricsEvent)).resolves.toBeUndefined()
  })
})

describe('console + noop sinks', () => {
  it('console sink routes through the supplied log', () => {
    const log = vi.fn()
    createConsoleMetricsSink(log).record({ jobId: 'j' } as JobMetricsEvent)
    expect(log).toHaveBeenCalledWith({ jobId: 'j' })
  })

  it('noop sink records nothing and never throws', () => {
    expect(() => noopMetricsSink.record({} as JobMetricsEvent)).not.toThrow()
  })
})

const jobBase = { jobId: 'j1', queue: 'crawl', jobType: 'crawl/site', attempts: 2, batchId: 'b1', siteId: 's1', userId: 7 }

describe('jobMetricsEvent is discriminated on status', () => {
  it('narrows to the fields each outcome actually has', () => {
    const evs: JobMetricsEvent[] = [
      { ...jobBase, status: 'completed', durationMs: 1, stats: { rowsFetched: 3 } },
      { ...jobBase, status: 'failed', durationMs: 1, error: 'TypeError: x', cause: new TypeError('x') },
      { ...jobBase, status: 'released', durationMs: null, error: 'rate-limited' },
    ]
    for (const e of evs) {
      if (e.status === 'completed')
        expect(e.stats.rowsFetched).toBe(3)
      else if (e.status === 'failed')
        expect(e.cause).toBeInstanceOf(TypeError)
      else
        expect(e.error).toBe('rate-limited')
    }
  })
})
