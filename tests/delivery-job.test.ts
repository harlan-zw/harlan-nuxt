import type { EventListenerEnvelope } from '../src/runtime/server/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventRuntimeError } from '../src/runtime/server/errors'
import definition from '../src/runtime/server/jobs/deliver-listener'
import { deliverQueuedListener, handleQueuedListenerTerminalFailure } from './fixtures/generated-runtime'

const envelope: EventListenerEnvelope = {
  _tag: 'event-listener',
  deliveryId: '5:evt-1:notify',
  eventId: 'evt-1',
  eventName: 'test:event',
  eventVersion: 1,
  listenerName: 'notify',
  occurredAt: '2026-08-05T00:00:00.000Z',
  payload: { value: 'hello' },
}

describe('generic listener delivery job', () => {
  beforeEach(() => {
    vi.mocked(deliverQueuedListener).mockReset()
    vi.mocked(handleQueuedListenerTerminalFailure).mockReset()
  })

  it('declares static maintenance locality and terminally fails permanent delivery errors', async () => {
    const fail = vi.fn()
    vi.mocked(deliverQueuedListener).mockRejectedValueOnce(eventRuntimeError('InvalidQueuedDelivery', 'stale version'))
    vi.mocked(handleQueuedListenerTerminalFailure).mockResolvedValueOnce(undefined)

    await definition.handle(envelope, { fail } as never)

    expect(definition.queue).toBe('maintenance')
    expect(handleQueuedListenerTerminalFailure).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledWith(expect.stringContaining('stale version'))
  })

  it('delegates exhausted retries to the queued listener terminal callback', async () => {
    const error = new Error('attempts exhausted')
    vi.mocked(handleQueuedListenerTerminalFailure).mockResolvedValueOnce(undefined)

    await definition.failed!(envelope, {} as never, error)

    expect(handleQueuedListenerTerminalFailure).toHaveBeenCalledWith(envelope, error, expect.anything())
  })
})
