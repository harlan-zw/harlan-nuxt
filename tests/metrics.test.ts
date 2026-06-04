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
  it('maps completed/failed/released hook payloads to events', () => {
    const events: JobMetricsEvent[] = []
    const hooks = metricsSinkToRepoHooks({ record: e => void events.push(e) })

    hooks.onJobCompleted!({ job: job(), durationMs: 4200, result: undefined })
    hooks.onJobFailed!({ job: job(), error: 'boom' })
    hooks.onJobReleased!({ job: job(), opts: { error: 'rate-limited' } })

    expect(events).toEqual([
      { jobId: 'j1', queue: 'crawl', jobType: 'crawl/site', status: 'completed', attempts: 2, durationMs: 4200, batchId: 'b1', siteId: 's1', userId: 7, error: undefined },
      { jobId: 'j1', queue: 'crawl', jobType: 'crawl/site', status: 'failed', attempts: 2, durationMs: 1234, batchId: 'b1', siteId: 's1', userId: 7, error: 'boom' },
      { jobId: 'j1', queue: 'crawl', jobType: 'crawl/site', status: 'released', attempts: 2, durationMs: null, batchId: 'b1', siteId: 's1', userId: 7, error: 'rate-limited' },
    ])
  })

  it('falls back to null durationMs on completed when the payload omits it', () => {
    const events: JobMetricsEvent[] = []
    const hooks = metricsSinkToRepoHooks({ record: e => void events.push(e) })
    hooks.onJobCompleted!({ job: job({ duration_ms: null }), durationMs: null })
    expect(events[0]!.durationMs).toBeNull()
  })
})

describe('combineMetricsSinks', () => {
  it('fans out to every sink and isolates a throwing one', () => {
    const a = vi.fn()
    const c = vi.fn()
    const sink = combineMetricsSinks(
      { record: a },
      { record: () => { throw new Error('bad sink') } },
      { record: c },
    )
    const event = { jobId: 'j', queue: 'q', jobType: 't', status: 'completed', attempts: 1, durationMs: 1, batchId: null, siteId: null, userId: null } as JobMetricsEvent
    expect(() => sink.record(event)).not.toThrow()
    expect(a).toHaveBeenCalledWith(event)
    expect(c).toHaveBeenCalledWith(event) // reached despite the middle sink throwing
  })

  it('swallows an async sink rejection', async () => {
    const sink = combineMetricsSinks({ record: () => Promise.reject(new Error('async boom')) })
    expect(() => sink.record({} as JobMetricsEvent)).not.toThrow()
    await Promise.resolve()
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
