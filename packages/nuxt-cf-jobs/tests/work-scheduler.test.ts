import { describe, expect, it } from 'vitest'
import { formatWatchEvent, planDrainLanes, selectNewTerminalJobs } from '../src/cli/index'

function q(queue: string, ready: number, maxConcurrency: number, maxBatchSize = 10) {
  return { queue, ready, reserved: 0, delayed: 0, completed: 0, failed: 0, maxConcurrency, maxBatchSize }
}

describe('planDrainLanes', () => {
  it('opens up to maxConcurrency lanes, capped by available work', () => {
    // 25 ready, batch 10 → ceil = 3 batches, but budget 2 → 2 lanes.
    expect(planDrainLanes([q('a', 25, 2, 10)], {})).toEqual([{ queue: 'a', fire: 2, batchSize: 10 }])
    // 5 ready, batch 10 → 1 batch needed even though budget is 4.
    expect(planDrainLanes([q('b', 5, 4, 10)], {})).toEqual([{ queue: 'b', fire: 1, batchSize: 10 }])
  })

  it('subtracts lanes already in flight', () => {
    expect(planDrainLanes([q('a', 100, 4, 10)], { a: 3 })).toEqual([{ queue: 'a', fire: 1, batchSize: 10 }])
    // already saturated → no new lanes
    expect(planDrainLanes([q('a', 100, 4, 10)], { a: 4 })).toEqual([])
  })

  it('skips idle queues and respects a single-queue filter', () => {
    const snap = [q('a', 0, 4), q('b', 20, 2)] // b: 20 ready / batch 10 = 2 batches, budget 2 → 2 lanes
    expect(planDrainLanes(snap, {})).toEqual([{ queue: 'b', fire: 2, batchSize: 10 }])
    expect(planDrainLanes(snap, {}, { onlyQueue: 'a' })).toEqual([])
  })

  it('fans out independently across queues (no head-of-line blocking)', () => {
    const plans = planDrainLanes([q('slow', 1, 1), q('fast', 30, 3)], { slow: 1 })
    // slow already has its 1 lane busy → only fast gets new lanes.
    expect(plans).toEqual([{ queue: 'fast', fire: 3, batchSize: 10 }])
  })
})

describe('selectNewTerminalJobs', () => {
  const j = (id: string, at: number) => ({ id, type: 't', queue: 'q', outcome: 'completed' as const, durationMs: 1, error: null, at })

  it('returns only unseen jobs, oldest-first', () => {
    const recent = [j('c', 30), j('b', 20), j('a', 10)] // newest-first as the endpoint returns
    const fresh = selectNewTerminalJobs(recent, new Set(['a']))
    expect(fresh.map(x => x.id)).toEqual(['b', 'c']) // chronological
  })

  it('emits nothing when all seen', () => {
    expect(selectNewTerminalJobs([j('a', 10)], new Set(['a']))).toEqual([])
  })
})

describe('formatWatchEvent', () => {
  it('emits a completed event with duration', () => {
    const line = formatWatchEvent({ id: 'x', type: 'crawl/scan', queue: 'crawl', outcome: 'completed', durationMs: 142, error: null, at: 1_700_000_000 })
    const e = JSON.parse(line)
    expect(e).toMatchObject({ event: 'completed', id: 'x', queue: 'crawl', type: 'crawl/scan', durationMs: 142 })
    expect(e.ts).toBe(new Date(1_700_000_000 * 1000).toISOString())
    expect(e.error).toBeUndefined()
  })

  it('emits a failed event with the FULL untruncated error', () => {
    const stack = 'Error: boom\n    at handler (file.ts:1:1)\n    at run (file.ts:2:2)'
    const line = formatWatchEvent({ id: 'y', type: 'reports/x', queue: 'reports', outcome: 'failed', durationMs: null, error: stack, at: 1_700_000_500 })
    const e = JSON.parse(line)
    expect(e).toMatchObject({ event: 'failed', id: 'y', queue: 'reports' })
    expect(e.error).toBe(stack) // full stack, not trimmed to the first line
  })
})
