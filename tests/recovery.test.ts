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
      staleBefore: 700,
      availableAt: 1_000,
      error: 'stale-reservation',
      limit: 10,
    })
    expect(repository.findDispatchableJobs).toHaveBeenCalledWith({
      now: 1_000,
      createdBefore: 400,
      limit: 10,
    })
    expect(sent).toEqual([{ queue: 'q', ids: ['stale-1', 'dupe', 'orphaned'] }])
    expect(result).toMatchObject({
      released: 2,
      terminalized: 0,
      swept: 3,
      dispatched: 1,
    })
  })

  it('terminalizes exhausted stale reservations BEFORE finding/releasing retriable ones', async () => {
    const callOrder: string[] = []
    const repository = {
      failStaleReservedJobs: vi.fn(async () => {
        callOrder.push('fail')
        return 3
      }),
      findStaleReservedJobs: vi.fn(async () => {
        callOrder.push('find')
        return [] as Array<{ id: string, queue: string }>
      }),
      releaseStaleReservedJobs: vi.fn(async () => 0),
      findDispatchableJobs: vi.fn(async () => [] as Array<{ id: string, queue: string }>),
    }
    const publisher = { sendBatch: vi.fn(async () => true) }

    const result = await recoverDurableJobs(repository, publisher, {
      now: 1_000,
      staleSeconds: 300,
      limit: 10,
      staleError: 'stale-reservation',
    })

    // exhausted jobs are cleared before the revive path runs, so they can't be
    // re-dispatched into the endless reaper loop.
    expect(callOrder).toEqual(['fail', 'find'])
    expect(repository.failStaleReservedJobs).toHaveBeenCalledWith({
      staleBefore: 700,
      error: 'stale-reservation: exhausted retries',
      limit: 10,
    })
    expect(result.terminalized).toBe(3)
  })
})
