import { describe, expect, it, vi } from 'vitest'
import { recoverDurableJobs } from '#cf-jobs/server'

describe('recoverDurableJobs', () => {
  it('releases stale reservations and dispatches unique stale + orphaned rows', async () => {
    const sent: Array<{ queue: string, ids: string[] }> = []
    const repository = {
      findStaleReservedJobs: vi.fn(async () => [
        { id: 'stale-1', queue: 'q' },
        { id: 'dupe', queue: 'q' },
      ]),
      releaseStaleReservedJobs: vi.fn(async () => 2),
      findDispatchableJobs: vi.fn(async () => [
        { id: 'dupe', queue: 'q' },
        { id: 'orphaned', queue: 'q' },
      ]),
    }
    const publisher = {
      sendBatch: vi.fn(async (queue: string, messages: Array<{ jobId: string }>) => {
        sent.push({ queue, ids: messages.map(m => m.jobId) })
        return true
      }),
    }

    const result = await recoverDurableJobs(repository, publisher, {
      now: 1_000,
      staleSeconds: 300,
      orphanedSeconds: 600,
      limit: 10,
    })

    expect(repository.findStaleReservedJobs).toHaveBeenCalledWith({ staleBefore: 700, limit: 10 })
    expect(repository.releaseStaleReservedJobs).toHaveBeenCalledWith({
      now: 1_000,
      staleBefore: 700,
      availableAt: 1_000,
      error: 'stale-reservation',
      limit: 10,
    })
    expect(repository.findDispatchableJobs).toHaveBeenCalledWith({
      now: 1_000,
      createdBefore: 400,
      staleReleasedBefore: 880,
      limit: 10,
    })
    expect(sent).toEqual([{ queue: 'q', ids: ['orphaned'] }])
    expect(result).toMatchObject({
      released: 2,
      terminalized: 0,
      swept: 1,
      dispatched: 1,
    })
  })

  it('terminalizes exhausted stale reservations BEFORE finding/releasing retriable ones', async () => {
    const callOrder: string[] = []
    const terminalizedJobs = [
      { id: 'dead-1', queue: 'q', batchId: 'batch-1' },
      { id: 'dead-2', queue: 'q', batchId: null },
      { id: 'dead-3', queue: 'q', batchId: 'batch-2' },
    ]
    const repository = {
      failStaleReservedJobs: vi.fn(async () => {
        callOrder.push('fail')
        return terminalizedJobs
      }),
      findStaleReservedJobs: vi.fn(async () => {
        callOrder.push('find')
        return [] as Array<{ id: string, queue: string }>
      }),
      releaseStaleReservedJobs: vi.fn(async () => 0),
      findDispatchableJobs: vi.fn(async () => [] as Array<{ id: string, queue: string }>),
    }
    const publisher = { sendBatch: vi.fn(async () => true) }
    const onTerminalized = vi.fn(async () => {})

    const result = await recoverDurableJobs(repository, publisher, {
      now: 1_000,
      staleSeconds: 300,
      limit: 10,
      staleError: 'stale-reservation',
      onTerminalized,
    })

    // exhausted jobs are cleared before the revive path runs, so they can't be
    // re-dispatched into the endless reaper loop.
    expect(callOrder).toEqual(['fail', 'find'])
    expect(repository.failStaleReservedJobs).toHaveBeenCalledWith({
      now: 1_000,
      staleBefore: 700,
      error: 'stale-reservation: exhausted retries',
      limit: 10,
    })
    expect(onTerminalized).toHaveBeenCalledWith(terminalizedJobs)
    expect(result.terminalized).toBe(3)
    expect(result.terminalizedJobs).toEqual(terminalizedJobs)
  })
})
