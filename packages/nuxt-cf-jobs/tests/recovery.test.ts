import type { DurableJobRecoveryQuery } from '#cf-jobs/server'
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
      findDispatchableJobs: vi.fn(async (query?: DurableJobRecoveryQuery) => query?.publication === 'unpublished'
        ? []
        : [
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
    expect(repository.findDispatchableJobs).toHaveBeenNthCalledWith(1, {
      now: 1_000,
      publication: 'unpublished',
      limit: 10,
    })
    expect(repository.findDispatchableJobs).toHaveBeenNthCalledWith(2, {
      now: 1_000,
      createdBefore: 400,
      staleReleasedBefore: 880,
      // Defaults to orphanedSeconds: a row is re-sent at most once per window.
      redispatchedBefore: 400,
      publication: 'published',
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

/**
 * Regression: the recovery sweep must not become the system's largest producer.
 *
 * nuxtseo.com, 2026-07-28/29. The previous implementation ordered by
 * `available_at ASC` and had no memory of what it had already re-sent. On a queue
 * whose consumer is slower than its producer (`max_concurrency: 1`, ~100 msg/hr)
 * every row eventually satisfies "due, unreserved, older than `orphanedSeconds`",
 * so each tick re-selected the SAME oldest `limit` rows and re-sent them. At
 * limit 300 on a two-minute cron that is 9,000 writes/hr against a 100/hr
 * consumer — measured at 8,987 — which deepened the backlog it existed to clear
 * and rebuilt a 122k-message queue within 23h of a full purge.
 *
 * Age cannot express the fix: `createdBefore` asks "is this row old?", true of
 * every row queued behind a backlog. The question is "did we already re-send it?".
 */
describe('recoverDurableJobs orphan re-dispatch damping', () => {
  function backloggedRepository(rows: Array<{ id: string, queue: string }>) {
    const noted: string[][] = []
    return {
      noted,
      repository: {
        findStaleReservedJobs: vi.fn(async () => []),
        releaseStaleReservedJobs: vi.fn(async () => 0),
        // A backlog: every row is old, due and unreserved on every tick.
        findDispatchableJobs: vi.fn(async (query?: DurableJobRecoveryQuery) => query?.publication === 'unpublished' ? [] : rows),
        noteOrphanRedispatch: vi.fn(async (ids: readonly string[]) => {
          noted.push([...ids])
          return ids.length
        }),
      },
    }
  }

  it('stamps every row it re-sent so the next sweep can exclude them', async () => {
    const { repository, noted } = backloggedRepository([
      { id: 'a', queue: 'q' },
      { id: 'b', queue: 'q' },
    ])
    const publisher = { sendBatch: vi.fn(async () => true) }

    const result = await recoverDurableJobs(repository, publisher, {
      now: 10_000,
      orphanedSeconds: 600,
      limit: 300,
    })

    expect(noted).toEqual([['a', 'b']])
    expect(repository.noteOrphanRedispatch).toHaveBeenCalledWith(['a', 'b'], { at: 10_000 })
    expect(result.redispatchNoted).toBe(2)
  })

  it('asks the repository to exclude rows re-dispatched within the window', async () => {
    const { repository } = backloggedRepository([{ id: 'a', queue: 'q' }])
    await recoverDurableJobs(repository, { sendBatch: vi.fn(async () => true) }, {
      now: 10_000,
      orphanedSeconds: 600,
      redispatchGraceSeconds: 3_600,
      limit: 300,
    })

    // Without this the sweep is memoryless and re-sends the same rows forever.
    expect(repository.findDispatchableJobs).toHaveBeenCalledWith(
      expect.objectContaining({ redispatchedBefore: 6_400 }),
    )
  })

  it('does NOT stamp a row whose queue send failed, so it stays eligible', async () => {
    const { repository, noted } = backloggedRepository([
      { id: 'ok', queue: 'good' },
      { id: 'lost', queue: 'bad' },
    ])
    const publisher = {
      sendBatch: vi.fn(async (queue: string) => queue === 'good'),
    }

    const result = await recoverDurableJobs(repository, publisher, { now: 10_000, limit: 300 })

    // Suppressing a row we never actually re-sent would strand it for a whole
    // window — the failure mode this backstop exists to prevent.
    expect(noted).toEqual([['ok']])
    expect(result.redispatchNoted).toBe(1)
  })

  it('degrades to the previous behaviour when the repository cannot stamp', async () => {
    const repository = {
      findStaleReservedJobs: vi.fn(async () => []),
      releaseStaleReservedJobs: vi.fn(async () => 0),
      findDispatchableJobs: vi.fn(async () => [{ id: 'a', queue: 'q' }]),
      // No noteOrphanRedispatch — an older repository implementation.
    }
    const publisher = { sendBatch: vi.fn(async () => true) }

    const result = await recoverDurableJobs(repository, publisher, { now: 10_000, limit: 300 })

    // Still recovers; just cannot damp. `redispatchNoted: 0` beside a non-zero
    // `swept` is the signal that the sweep is running memoryless.
    expect(result.swept).toBe(1)
    expect(result.dispatched).toBe(1)
    expect(result.redispatchNoted).toBe(0)
  })
})
