import type { EventCommitInput, QueuedListenerPublication } from '../src/runtime/server/types'
import { describe, expect, it, vi } from 'vitest'
import { createCfJobsEventQueueAdapter } from '../src/runtime/server/adapters/cf-jobs'

const publication: QueuedListenerPublication = {
  deliveryId: '5:evt-1:notify',
  queue: 'notifications',
  tries: 3,
  backoff: [10, 60],
  envelope: {
    _tag: 'event-listener',
    deliveryId: '5:evt-1:notify',
    eventId: 'evt-1',
    eventName: 'user:created',
    eventVersion: 1,
    listenerName: 'notify',
    occurredAt: '2026-08-05T00:00:00.000Z',
    payload: { userId: 42 },
  },
}

const analyticsPublication: QueuedListenerPublication = {
  ...publication,
  deliveryId: '5:evt-1:analytics',
  queue: 'analytics',
  envelope: {
    ...publication.envelope,
    deliveryId: '5:evt-1:analytics',
    listenerName: 'analytics',
  },
}

function fixture() {
  const trace: string[] = []
  const repository = {
    prepareStageJobs: vi.fn(records => ({ ok: true, value: { records, statements: ['insert-job'] } })),
  }
  const outbox = {
    prepareDurableJobResult: vi.fn(async input => ({
      ok: true,
      value: {
        id: input.id,
        queue: input.route.queue,
        jobType: input.route.jobType,
        traceId: input.traceId,
        payload: JSON.stringify(input.payload),
        attempts: 0,
        maxAttempts: input.defaultMaxAttempts,
        backoff: input.backoff,
        availableAt: 1,
        createdAt: 1,
      },
    })),
    stagePreparedDurableJobs: vi.fn(async (_repository, records) => {
      trace.push('stage')
      return { status: 'staged' as const, records }
    }),
    publishDurableJobBatch: vi.fn(async (_repository, _publisher, records: readonly { id: string, queue: string }[]) => {
      trace.push('publish')
      const queues = [...new Set(records.map(record => record.queue))]
      return queues.map(queue => ({
        queue,
        status: 'published' as const,
        jobIds: records.filter(record => record.queue === queue).map(record => record.id),
      }))
    }),
  }
  const adapter = createCfJobsEventQueueAdapter({ outbox, repository, publisher: {} })
  return { adapter, outbox, repository, trace }
}

describe('nuxt-cf-jobs adapter', () => {
  it('stages before transport and creates one operator-readable durable job per listener', async () => {
    const { adapter, outbox, trace } = fixture()
    await adapter.queue.publishImmediate([publication], { observe: () => {} })

    expect(trace).toEqual(['stage', 'publish'])
    expect(outbox.prepareDurableJobResult).toHaveBeenCalledWith(expect.objectContaining({
      name: 'events/deliver-listener',
      id: publication.deliveryId,
      traceId: publication.envelope.eventId,
      route: { queue: 'notifications', jobType: 'event-listener/notify' },
      defaultMaxAttempts: 3,
      backoff: [10, 60],
    }))
  })

  it('exposes unpublished D1 statements to the caller-owned unit of work', async () => {
    const { adapter } = fixture()
    const input: EventCommitInput = {
      planId: 'plan',
      eventId: 'evt-1',
      eventName: 'user:created',
      publications: [publication],
    }

    const stage = await adapter.prepareCommitStage(input)

    expect(stage.statements).toEqual(['insert-job'])
    expect(stage.receipt).toEqual({ _tag: 'staged-event-listeners', deliveryIds: [publication.deliveryId] })
  })

  it('rejects a prepared stage which omits a requested listener delivery', async () => {
    const { adapter, repository } = fixture()
    repository.prepareStageJobs.mockReturnValueOnce({ ok: true, value: { records: [], statements: [] } })

    await expect(adapter.prepareCommitStage({
      planId: 'plan',
      eventId: 'evt-1',
      eventName: 'user:created',
      publications: [publication],
    })).rejects.toMatchObject({ _tag: 'CfJobsEventAdapterError', stage: 'prepare-stage-failed' })
  })

  it('maps grouped results back to every listener, including a route different from the generic maintenance queue', async () => {
    const { adapter, outbox } = fixture()
    ;(outbox.publishDurableJobBatch as unknown as { mockResolvedValueOnce: (value: unknown) => void }).mockResolvedValueOnce([
      { queue: 'notifications', status: 'published', jobIds: [publication.deliveryId] },
      { queue: 'analytics', status: 'not-dispatched', jobIds: [analyticsPublication.deliveryId] },
    ])

    const outcomes = await adapter.queue.publishImmediate([publication, analyticsPublication], { observe: () => {} })

    expect(outcomes).toEqual([
      { _tag: 'published', deliveryId: publication.deliveryId, queue: 'notifications' },
      expect.objectContaining({ _tag: 'failed', deliveryId: analyticsPublication.deliveryId, queue: 'analytics', status: 'not-dispatched' }),
    ])
    expect(outbox.prepareDurableJobResult).toHaveBeenNthCalledWith(2, expect.objectContaining({
      name: 'events/deliver-listener',
      route: { queue: 'analytics', jobType: 'event-listener/analytics' },
    }))
  })

  it('returns failed outcomes instead of swallowing publication failure', async () => {
    const { adapter, outbox } = fixture()
    ;(outbox.publishDurableJobBatch as unknown as { mockResolvedValueOnce: (value: unknown) => void }).mockResolvedValueOnce([{
      queue: 'notifications',
      status: 'not-dispatched',
      jobIds: [publication.deliveryId],
    }])

    await expect(adapter.queue.publishImmediate([publication], { observe: () => {} })).resolves.toEqual([
      expect.objectContaining({ _tag: 'failed', deliveryId: publication.deliveryId, status: 'not-dispatched' }),
    ])
  })
})
