import { describe, expect, it } from 'vitest'
import {
  chunk,
  findD1Binding,
  resolveQueueWorkerConfig,
  runDevWorkerTick,
  runWithConcurrency,
} from '../src/runtime/server/dev-worker'

describe('resolveQueueWorkerConfig', () => {
  it('defaults to serial / batch-10 for a bare string binding', () => {
    expect(resolveQueueWorkerConfig('SOME_QUEUE')).toEqual({ maxConcurrency: 1, maxBatchSize: 10 })
    expect(resolveQueueWorkerConfig(undefined)).toEqual({ maxConcurrency: 1, maxBatchSize: 10 })
  })

  it('reads maxConcurrency / maxBatchSize off an options object', () => {
    expect(resolveQueueWorkerConfig({ maxConcurrency: 4, maxBatchSize: 25 })).toEqual({ maxConcurrency: 4, maxBatchSize: 25 })
  })

  it('falls back when a field is missing or invalid', () => {
    expect(resolveQueueWorkerConfig({ maxConcurrency: 3 })).toEqual({ maxConcurrency: 3, maxBatchSize: 10 })
    expect(resolveQueueWorkerConfig({ maxConcurrency: 0, maxBatchSize: -2 })).toEqual({ maxConcurrency: 1, maxBatchSize: 10 })
  })
})

describe('chunk', () => {
  it('splits into fixed-size groups', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('treats a non-positive size as 1', () => {
    expect(chunk([1, 2], 0)).toEqual([[1], [2]])
  })
})

describe('runWithConcurrency', () => {
  it('never exceeds the concurrency cap', async () => {
    let inFlight = 0
    let peak = 0
    const tasks = Array.from({ length: 6 }, () => async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await sleep(5)
      inFlight--
      return inFlight
    })
    await runWithConcurrency(tasks, 2)
    expect(peak).toBe(2)
  })

  it('runs all tasks and preserves order', async () => {
    const results = await runWithConcurrency([
      async () => 'a',
      async () => 'b',
      async () => 'c',
    ], 1)
    expect(results).toEqual(['a', 'b', 'c'])
  })
})

describe('findD1Binding', () => {
  const db = { prepare: () => ({}), exec: async () => {} }

  it('auto-detects a single D1 binding', () => {
    const match = findD1Binding({ DB: db, KV: { get() {} } })
    expect(match?.binding).toBe('DB')
    expect(match?.ambiguous).toBeUndefined()
  })

  it('flags ambiguity when multiple D1 bindings exist', () => {
    const match = findD1Binding({ MAIN: db, OTHER: { prepare: () => ({}), exec: async () => {} } })
    expect(match?.binding).toBe('MAIN')
    expect(match?.ambiguous).toEqual(['MAIN', 'OTHER'])
  })

  it('honours an explicit preferred binding', () => {
    expect(findD1Binding({ DB: db }, 'DB')?.binding).toBe('DB')
    expect(findD1Binding({ DB: db }, 'NOPE')).toBeUndefined()
  })

  it('returns undefined when no binding looks like D1', () => {
    expect(findD1Binding({ KV: { get() {} } })).toBeUndefined()
  })
})

describe('runDevWorkerTick', () => {
  function fakeDeps(ready: Array<{ id: string, queue: string }>, config: Record<string, { maxConcurrency: number, maxBatchSize: number }> = {}) {
    let findCalls = 0
    let peak = 0
    let inFlight = 0
    const dispatched: Array<{ queue: string, ids: string[] }> = []
    const deps = {
      findDispatchable: async () => (findCalls++ === 0 ? ready : []),
      queueConfig: (queue: string) => config[queue] ?? { maxConcurrency: 1, maxBatchSize: 10 },
      async dispatchBatch(queue: string, messages: ReadonlyArray<{ jobId: string, queue: string }>) {
        inFlight++
        peak = Math.max(peak, inFlight)
        dispatched.push({ queue, ids: messages.map(m => m.jobId) })
        await sleep(5)
        inFlight--
      },
    }
    return { deps, dispatched, peak: () => peak }
  }

  it('drains ready jobs grouped per queue and reports counts', async () => {
    const { deps, dispatched } = fakeDeps([
      { id: 'a1', queue: 'alpha' },
      { id: 'a2', queue: 'alpha' },
      { id: 'b1', queue: 'beta' },
    ])
    const result = await runDevWorkerTick(deps, { limit: 100 })
    expect(result.processed).toBe(3)
    expect(result.byQueue).toEqual({ alpha: 2, beta: 1 })
    expect(result.remaining).toBe(0)
    expect(dispatched.flatMap(d => d.ids).sort()).toEqual(['a1', 'a2', 'b1'])
  })

  it('chunks by maxBatchSize and caps batches at maxConcurrency', async () => {
    const ready = Array.from({ length: 6 }, (_, i) => ({ id: `j${i}`, queue: 'q' }))
    const { deps, dispatched, peak } = fakeDeps(ready, { q: { maxConcurrency: 2, maxBatchSize: 2 } })
    const result = await runDevWorkerTick(deps, { limit: 100 })
    expect(result.processed).toBe(6)
    expect(dispatched).toHaveLength(3) // 6 jobs / batch-size 2
    expect(dispatched.every(d => d.ids.length === 2)).toBe(true)
    expect(peak()).toBe(2)
  })

  it('restricts to a single queue when asked', async () => {
    const { deps, dispatched } = fakeDeps([
      { id: 'a1', queue: 'alpha' },
      { id: 'b1', queue: 'beta' },
    ])
    const result = await runDevWorkerTick(deps, { limit: 100, queue: 'beta' })
    expect(result.processed).toBe(1)
    expect(result.byQueue).toEqual({ beta: 1 })
    expect(dispatched).toEqual([{ queue: 'beta', ids: ['b1'] }])
  })

  it('is a no-op when nothing is ready', async () => {
    const { deps, dispatched } = fakeDeps([])
    const result = await runDevWorkerTick(deps, { limit: 100 })
    expect(result).toEqual({ processed: 0, byQueue: {}, remaining: 0 })
    expect(dispatched).toEqual([])
  })
})

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
