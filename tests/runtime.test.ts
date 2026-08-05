import type {
  AnyEventDefinition,
  AnyListenerDefinition,
  EventListenerEnvelope,
  GeneratedEventEntry,
  GeneratedListenerEntry,
  QueuedListenerPublication,
} from '../src/runtime/server/types'
import { describe, expect, it, vi } from 'vitest'
import { isEventRuntimeError } from '../src/runtime/server/errors'
import { createGeneratedEventRegistry } from '../src/runtime/server/registry'
import { createGeneratedEventRuntime, isPermanentQueuedDeliveryError, safeParseEventListenerEnvelope } from '../src/runtime/server/runtime'

const payloadCodec = {
  parse(input: unknown) {
    if (!input || typeof input !== 'object' || typeof (input as { value?: unknown }).value !== 'string')
      throw new TypeError('value must be a string')
    return input as { value: string }
  },
  encode(payload: { value: string }) {
    return { value: payload.value }
  },
}

function eventEntry(name = 'test:event', load = vi.fn(async (): Promise<AnyEventDefinition> => ({
  name,
  transport: { _tag: 'transfer', version: 1 },
  codec: payloadCodec,
}))): GeneratedEventEntry {
  return { name, transport: { _tag: 'transfer', version: 1, maxBytes: 65_536 }, load }
}

function listenerEntry(
  name: string,
  execution: GeneratedListenerEntry['execution'],
  handle: AnyListenerDefinition['handle'],
  load = vi.fn(async (): Promise<AnyListenerDefinition> => ({ name, event: 'test:event', execution, handle } as AnyListenerDefinition)),
): GeneratedListenerEntry {
  return { name, event: 'test:event', execution, hasIdempotency: execution._tag === 'queued', load }
}

function published(publications: readonly QueuedListenerPublication[]) {
  return publications.map(publication => ({
    _tag: 'published' as const,
    deliveryId: publication.deliveryId,
    queue: publication.queue,
  }))
}

describe('event runtime', () => {
  it('always invokes the runtime observer alongside a per-dispatch observer', async () => {
    const runtimeObserver = vi.fn()
    const dispatchObserver = vi.fn()
    const registry = createGeneratedEventRegistry({
      manifestHash: 'hash',
      events: [eventEntry()],
      listeners: [listenerEntry('isolated', { _tag: 'sync', failure: 'isolate' }, () => {
        throw new Error('visible failure')
      })],
    })

    const report = await createGeneratedEventRuntime(registry, { observe: runtimeObserver })
      .dispatchEvent('test:event', { value: 'x' }, { observe: dispatchObserver })

    expect(report.isolatedFailures).toEqual(['isolated'])
    expect(runtimeObserver).toHaveBeenCalledWith(expect.objectContaining({ _tag: 'listener-failed', listenerName: 'isolated' }))
    expect(dispatchObserver).toHaveBeenCalledWith(expect.objectContaining({ _tag: 'listener-failed', listenerName: 'isolated' }))
  })

  it('runs default sync listeners serially and aborts all later work on propagated failure', async () => {
    const trace: string[] = []
    const first = listenerEntry('first', { _tag: 'sync', failure: 'propagate' }, async () => {
      trace.push('first:start')
      await Promise.resolve()
      trace.push('first:end')
    })
    const abort = listenerEntry('abort', { _tag: 'sync', failure: 'propagate' }, () => {
      trace.push('abort')
      throw new Error('stop')
    })
    const deferredLoad = vi.fn(async (): Promise<AnyListenerDefinition> => ({
      name: 'later-deferred',
      event: 'test:event',
      execution: { _tag: 'deferred', failure: 'isolate' },
      handle: () => { trace.push('deferred') },
    }))
    const queuedLoad = vi.fn(async (): Promise<AnyListenerDefinition> => ({
      name: 'later-queued',
      event: 'test:event',
      execution: { _tag: 'queued', queue: 'events', publication: 'immediate' },
      idempotency: { key: () => 'key' },
      handle: () => { trace.push('queued') },
    } as AnyListenerDefinition))
    const registry = createGeneratedEventRegistry({
      manifestHash: 'hash',
      events: [eventEntry()],
      listeners: [
        first,
        abort,
        { name: 'later-deferred', event: 'test:event', execution: { _tag: 'deferred', failure: 'isolate' }, hasIdempotency: false, load: deferredLoad },
        { name: 'later-queued', event: 'test:event', execution: { _tag: 'queued', queue: 'events', publication: 'immediate' }, hasIdempotency: true, load: queuedLoad },
      ],
    })
    const runtime = createGeneratedEventRuntime(registry)
    const publishImmediate = vi.fn(async (publications: readonly QueuedListenerPublication[]) => published(publications))
    const waitUntil = vi.fn()

    await expect(runtime.dispatchEvent('test:event', { value: 'x' }, {
      eventId: 'evt-1',
      queue: { publishImmediate, dispatchCommitted: vi.fn(async (publications: readonly QueuedListenerPublication[]) => published(publications)) },
      waitUntil,
      observe: () => {},
    })).rejects.toSatisfy(error => isEventRuntimeError(error) && error._tag === 'ListenerFailure')

    expect(trace).toEqual(['first:start', 'first:end', 'abort'])
    expect(deferredLoad).not.toHaveBeenCalled()
    expect(queuedLoad).not.toHaveBeenCalled()
    expect(publishImmediate).not.toHaveBeenCalled()
    expect(waitUntil).not.toHaveBeenCalled()
  })

  it('brands runtime errors so colliding application tags remain retryable defects', async () => {
    const collision = Object.assign(new Error('transient'), { _tag: 'ListenerPayloadMismatch' })
    const registry = createGeneratedEventRegistry({
      manifestHash: 'hash',
      events: [eventEntry()],
      listeners: [listenerEntry('collision', { _tag: 'sync', failure: 'propagate' }, () => { throw collision })],
    })

    await expect(createGeneratedEventRuntime(registry).dispatchEvent('test:event', { value: 'x' }))
      .rejects
      .toSatisfy(error => isEventRuntimeError(error) && error._tag === 'ListenerFailure' && error.cause === collision)
    expect(isPermanentQueuedDeliveryError(collision)).toBe(false)
  })

  it('reports completed, failed, and not-started listeners after partial sync fan-out', async () => {
    const observations: unknown[] = []
    const registry = createGeneratedEventRegistry({
      manifestHash: 'hash',
      events: [eventEntry()],
      listeners: [
        listenerEntry('completed', { _tag: 'sync', failure: 'propagate' }, () => {}),
        listenerEntry('failed', { _tag: 'sync', failure: 'propagate' }, () => { throw new Error('stop') }),
        listenerEntry('not-started', { _tag: 'sync', failure: 'propagate' }, () => {}),
      ],
    })

    await expect(createGeneratedEventRuntime(registry).dispatchEvent('test:event', { value: 'x' }, {
      observe: (observation) => { observations.push(observation) },
    })).rejects.toThrow('Listener "failed" failed')

    expect(observations).toContainEqual(expect.objectContaining({
      _tag: 'dispatch-failed',
      completed: ['completed'],
      failed: ['failed'],
      queued: [],
      notStarted: ['not-started'],
    }))
  })

  it('loads only the selected event contract and matching sync listener', async () => {
    const selectedEventLoad = vi.fn(async (): Promise<AnyEventDefinition> => ({ name: 'selected', transport: { _tag: 'local' }, input: { parse: input => input } }))
    const otherEventLoad = vi.fn(async (): Promise<AnyEventDefinition> => ({ name: 'other', transport: { _tag: 'local' }, input: { parse: input => input } }))
    const selectedListenerLoad = vi.fn(async (): Promise<AnyListenerDefinition> => ({ name: 'selected-listener', event: 'selected', handle: () => {} }))
    const otherListenerLoad = vi.fn(async (): Promise<AnyListenerDefinition> => ({ name: 'other-listener', event: 'other', handle: () => {} }))
    const registry = createGeneratedEventRegistry({
      manifestHash: 'hash',
      events: [
        { name: 'selected', transport: { _tag: 'local' }, load: selectedEventLoad },
        { name: 'other', transport: { _tag: 'local' }, load: otherEventLoad },
      ],
      listeners: [
        { name: 'selected-listener', event: 'selected', execution: { _tag: 'sync', failure: 'propagate' }, hasIdempotency: false, load: selectedListenerLoad },
        { name: 'other-listener', event: 'other', execution: { _tag: 'sync', failure: 'propagate' }, hasIdempotency: false, load: otherListenerLoad },
      ],
    })

    await createGeneratedEventRuntime(registry).dispatchEvent('selected', { requestOnly: () => true })

    expect(selectedEventLoad).toHaveBeenCalledOnce()
    expect(selectedListenerLoad).toHaveBeenCalledOnce()
    expect(otherEventLoad).not.toHaveBeenCalled()
    expect(otherListenerLoad).not.toHaveBeenCalled()
  })

  it('runs listener middleware in order and skips sync listeners when their condition is false', async () => {
    const trace: string[] = []
    const registry = createGeneratedEventRegistry({
      manifestHash: 'hash',
      events: [eventEntry()],
      listeners: [
        {
          name: 'conditional',
          event: 'test:event',
          execution: { _tag: 'sync', failure: 'propagate' },
          hasIdempotency: false,
          load: async () => ({
            name: 'conditional',
            event: 'test:event',
            shouldHandle: () => false,
            handle: () => { trace.push('conditional:handle') },
          }),
        },
        {
          name: 'middleware',
          event: 'test:event',
          execution: { _tag: 'sync', failure: 'propagate' },
          hasIdempotency: false,
          load: async () => ({
            name: 'middleware',
            event: 'test:event',
            middleware: [
              async (_payload, _context, next) => {
                trace.push('outer:before')
                await next()
                trace.push('outer:after')
              },
              async (_payload, _context, next) => {
                trace.push('inner:before')
                await next()
                trace.push('inner:after')
              },
            ],
            handle: () => { trace.push('handle') },
          }),
        },
      ],
    })

    const result = await createGeneratedEventRuntime(registry).dispatchEvent('test:event', { value: 'x' })

    expect(result.syncCompleted).toEqual(['conditional', 'middleware'])
    expect(trace).toEqual(['outer:before', 'inner:before', 'handle', 'inner:after', 'outer:after'])
  })

  it('publishes queued envelopes without importing listener implementations and requires a stable event id', async () => {
    const queuedLoad = vi.fn()
    const registry = createGeneratedEventRegistry({
      manifestHash: 'hash',
      events: [eventEntry()],
      listeners: [{
        name: 'notify',
        event: 'test:event',
        execution: { _tag: 'queued', queue: 'notifications', publication: 'immediate', tries: 3, backoff: [10, 60] },
        hasIdempotency: true,
        load: queuedLoad,
      }],
    })
    const runtime = createGeneratedEventRuntime(registry)
    const publishImmediate = vi.fn(async (publications: readonly QueuedListenerPublication[]) => published(publications))
    const context = { queue: { publishImmediate, dispatchCommitted: vi.fn(async (publications: readonly QueuedListenerPublication[]) => published(publications)) }, observe: () => {} }

    await expect(runtime.dispatchEvent('test:event', { value: 'x' }, context)).rejects.toSatisfy(error => isEventRuntimeError(error) && error._tag === 'InvalidQueuedDelivery')
    await runtime.dispatchEvent('test:event', { value: 'x' }, { ...context, eventId: 'domain-event-7' })

    expect(queuedLoad).not.toHaveBeenCalled()
    expect(publishImmediate).toHaveBeenCalledOnce()
    const publications = publishImmediate.mock.calls[0]![0]
    expect(publications[0]).toMatchObject({
      deliveryId: '14:domain-event-7:notify',
      queue: 'notifications',
      tries: 3,
      backoff: [10, 60],
      envelope: { eventId: 'domain-event-7', listenerName: 'notify', payload: { value: 'x' } },
    })
  })

  it('leaves rollback transport-empty, then dispatches only after a committed unit of work resolves', async () => {
    const trace: string[] = []
    const registry = createGeneratedEventRegistry({
      manifestHash: 'hash',
      events: [eventEntry()],
      listeners: [{
        name: 'project',
        event: 'test:event',
        execution: { _tag: 'queued', queue: 'durable', publication: 'after-commit' },
        hasIdempotency: true,
        load: vi.fn(),
      }],
    })
    const runtime = createGeneratedEventRuntime(registry)
    const queue = {
      publishImmediate: vi.fn(async (publications: readonly QueuedListenerPublication[]) => published(publications)),
      dispatchCommitted: vi.fn(async (publications: readonly QueuedListenerPublication[]) => {
        trace.push('transport')
        return published(publications)
      }),
    }
    const plan = await runtime.planEvent('test:event', { value: 'x' }, { eventId: 'evt-commit', observe: () => {} })
    const rolledBack = await runtime.commitEventPlan(plan, {
      commit: async () => {
        trace.push('rollback')
        return { _tag: 'rolled-back' as const, reason: 'domain write failed' }
      },
    }, { queue, observe: () => {} })
    expect(rolledBack._tag).toBe('rolled-back')
    expect(queue.dispatchCommitted).not.toHaveBeenCalled()

    const committedPlan = await runtime.planEvent('test:event', { value: 'x' }, { eventId: 'evt-commit-2', observe: () => {} })
    await runtime.commitEventPlan(committedPlan, {
      commit: async ({ publications }) => {
        trace.push('commit')
        return {
          _tag: 'committed' as const,
          receipt: { _tag: 'staged-event-listeners' as const, deliveryIds: publications.map(publication => publication.deliveryId) },
        }
      },
    }, { queue, observe: () => {} })
    expect(trace).toEqual(['rollback', 'commit', 'transport'])
  })

  it('rejects synchronous listeners mixed into an after-commit event before running them', async () => {
    const syncHandle = vi.fn()
    const registry = createGeneratedEventRegistry({
      manifestHash: 'hash',
      events: [eventEntry()],
      listeners: [
        listenerEntry('sync', { _tag: 'sync', failure: 'propagate' }, syncHandle),
        { name: 'project', event: 'test:event', execution: { _tag: 'queued', queue: 'durable', publication: 'after-commit' }, hasIdempotency: true, load: vi.fn() },
      ],
    })

    await expect(createGeneratedEventRuntime(registry).planEvent('test:event', { value: 'x' }, {
      eventId: 'mixed-plan',
      observe: () => {},
    })).rejects.toSatisfy(error => isEventRuntimeError(error) && error._tag === 'EventPlanQueueMismatch')
    expect(syncHandle).not.toHaveBeenCalled()
  })

  it('freezes after-commit plans, requires an exact staging receipt, and dispatches the original publications', async () => {
    const registry = createGeneratedEventRegistry({
      manifestHash: 'hash',
      events: [eventEntry()],
      listeners: [{
        name: 'project',
        event: 'test:event',
        execution: { _tag: 'queued', queue: 'durable', publication: 'after-commit' },
        hasIdempotency: true,
        load: vi.fn(),
      }],
    })
    const runtime = createGeneratedEventRuntime(registry)
    const dispatchCommitted = vi.fn(async (publications: readonly QueuedListenerPublication[]) => published(publications))
    const queue = {
      publishImmediate: vi.fn(async (publications: readonly QueuedListenerPublication[]) => published(publications)),
      dispatchCommitted,
    }
    const plan = await runtime.planEvent('test:event', { value: 'x' }, { eventId: 'receipt-mismatch', observe: () => {} })

    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.publications)).toBe(true)
    expect(Object.isFrozen(plan.publications[0])).toBe(true)
    expect(Object.isFrozen(plan.publications[0]!.envelope.payload)).toBe(true)
    expect(() => (plan.publications as QueuedListenerPublication[]).push(plan.publications[0]!)).toThrow()

    await expect(runtime.commitEventPlan(plan, {
      commit: async () => ({
        _tag: 'committed',
        receipt: { _tag: 'staged-event-listeners', deliveryIds: ['wrong-id'] },
      }),
    }, { queue, observe: () => {} })).rejects.toSatisfy(error => isEventRuntimeError(error) && error._tag === 'EventPlanQueueMismatch')
    expect(dispatchCommitted).not.toHaveBeenCalled()

    const validPlan = await runtime.planEvent('test:event', { value: 'x' }, { eventId: 'receipt-valid', observe: () => {} })
    await runtime.commitEventPlan(validPlan, {
      commit: async ({ publications }) => ({
        _tag: 'committed',
        receipt: { _tag: 'staged-event-listeners', deliveryIds: publications.map(publication => publication.deliveryId) },
      }),
    }, { queue, observe: () => {} })
    expect(dispatchCommitted).toHaveBeenCalledWith(validPlan.publications, expect.anything())
  })

  it('preserves every sibling outcome when queue publication partially fails', async () => {
    const observations: Array<{ _tag: string, listenerName?: string }> = []
    const registry = createGeneratedEventRegistry({
      manifestHash: 'hash',
      events: [eventEntry()],
      listeners: [
        { name: 'sent', event: 'test:event', execution: { _tag: 'queued', queue: 'notifications', publication: 'immediate' }, hasIdempotency: true, load: vi.fn() },
        { name: 'pending', event: 'test:event', execution: { _tag: 'queued', queue: 'analytics', publication: 'immediate' }, hasIdempotency: true, load: vi.fn() },
      ],
    })
    const runtime = createGeneratedEventRuntime(registry)

    await expect(runtime.dispatchEvent('test:event', { value: 'x' }, {
      eventId: 'partial-1',
      queue: {
        publishImmediate: async publications => [
          { _tag: 'published', deliveryId: publications[0]!.deliveryId, queue: publications[0]!.queue },
          { _tag: 'failed', deliveryId: publications[1]!.deliveryId, queue: publications[1]!.queue, status: 'not-dispatched', error: new Error('binding unavailable') },
        ],
        dispatchCommitted: async publications => published(publications),
      },
      observe: (observation) => { observations.push(observation) },
    })).rejects.toSatisfy(error => isEventRuntimeError(error) && error._tag === 'QueueDispatchFailure')

    expect(observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ _tag: 'queue-published', listenerName: 'sent', queue: 'notifications' }),
      expect.objectContaining({ _tag: 'queue-failed', listenerName: 'pending', queue: 'analytics' }),
    ]))
  })

  it('reports partial after-commit publication with durable sibling detail', async () => {
    const observations: unknown[] = []
    const registry = createGeneratedEventRegistry({
      manifestHash: 'hash',
      events: [eventEntry()],
      listeners: [
        { name: 'sent', event: 'test:event', execution: { _tag: 'queued', queue: 'notifications', publication: 'after-commit' }, hasIdempotency: true, load: vi.fn() },
        { name: 'pending', event: 'test:event', execution: { _tag: 'queued', queue: 'analytics', publication: 'after-commit' }, hasIdempotency: true, load: vi.fn() },
      ],
    })
    const runtime = createGeneratedEventRuntime(registry)
    const plan = await runtime.planEvent('test:event', { value: 'x' }, { eventId: 'partial-after-commit', observe: () => {} })

    await expect(runtime.commitEventPlan(plan, {
      commit: async ({ publications }) => ({
        _tag: 'committed',
        receipt: { _tag: 'staged-event-listeners', deliveryIds: publications.map(publication => publication.deliveryId) },
      }),
    }, {
      queue: {
        publishImmediate: async publications => published(publications),
        dispatchCommitted: async publications => [
          { _tag: 'published', deliveryId: publications[0]!.deliveryId, queue: publications[0]!.queue },
          { _tag: 'failed', deliveryId: publications[1]!.deliveryId, queue: publications[1]!.queue, status: 'not-dispatched', error: new Error('binding unavailable') },
        ],
      },
      observe: (observation) => { observations.push(observation) },
    })).rejects.toSatisfy(error => isEventRuntimeError(error) && error._tag === 'QueueDispatchFailure')

    expect(observations).toContainEqual(expect.objectContaining({
      _tag: 'dispatch-failed',
      queued: ['sent'],
      failed: ['pending'],
      notStarted: [],
    }))
  })

  it('supports reserved object property names in generated registries', async () => {
    for (const name of ['toString', '__proto__', 'constructor']) {
      const handle = vi.fn()
      const registry = createGeneratedEventRegistry({
        manifestHash: 'hash',
        events: [{ name, transport: { _tag: 'local' }, load: async () => ({ name, transport: { _tag: 'local' }, input: { parse: input => input } }) }],
        listeners: [{ name: `listener:${name}`, event: name, execution: { _tag: 'sync', failure: 'propagate' }, hasIdempotency: false, load: async () => ({ name: `listener:${name}`, event: name, handle }) }],
      })

      await createGeneratedEventRuntime(registry).dispatchEvent(name, {})
      expect(handle).toHaveBeenCalledOnce()
    }
  })

  it('parses exact immutable queued envelopes and rejects request-only or stale shapes', () => {
    const valid = {
      _tag: 'event-listener',
      deliveryId: '5:evt-1:notify',
      eventId: 'evt-1',
      eventName: 'test:event',
      eventVersion: 1,
      listenerName: 'notify',
      occurredAt: '2026-08-05T00:00:00.000Z',
      payload: { value: 'hello' },
    }
    const parsed = safeParseEventListenerEnvelope(valid)
    expect(parsed).toMatchObject({ success: true })
    if (parsed.success) {
      expect(parsed.data).not.toBe(valid)
      expect(Object.isFrozen(parsed.data)).toBe(true)
      expect(Object.isFrozen(parsed.data.payload)).toBe(true)
    }
    expect(safeParseEventListenerEnvelope({ ...valid, occurredAt: undefined }).success).toBe(false)
    expect(safeParseEventListenerEnvelope({ ...valid, eventId: 7 }).success).toBe(false)
    expect(safeParseEventListenerEnvelope({ ...valid, occurredAt: 'yesterday' }).success).toBe(false)
    expect(safeParseEventListenerEnvelope({ ...valid, request: {} }).success).toBe(false)
  })

  it('keeps observer defects visible without relabelling success or replacing business failure', async () => {
    const observed: string[] = []
    const fallback = vi.fn()
    const successRegistry = createGeneratedEventRegistry({
      manifestHash: 'hash',
      events: [{ name: 'local', transport: { _tag: 'local' }, load: async () => ({ name: 'local', transport: { _tag: 'local' }, input: { parse: input => input } }) }],
      listeners: [{
        name: 'success',
        event: 'local',
        execution: { _tag: 'sync', failure: 'propagate' },
        hasIdempotency: false,
        load: async () => ({ name: 'success', event: 'local', handle: () => {} }),
      }],
    })
    await expect(createGeneratedEventRuntime(successRegistry).dispatchEvent('local', {}, {
      observe: (observation) => {
        observed.push(observation._tag)
        if (observation._tag === 'listener-completed')
          throw new Error('observer down')
      },
      observerFallback: fallback,
    })).resolves.toMatchObject({ syncCompleted: ['success'] })
    expect(observed).not.toContain('listener-failed')
    expect(fallback).toHaveBeenCalledOnce()

    const failureRegistry = createGeneratedEventRegistry({
      manifestHash: 'hash',
      events: [{ name: 'local', transport: { _tag: 'local' }, load: async () => ({ name: 'local', transport: { _tag: 'local' }, input: { parse: input => input } }) }],
      listeners: [{
        name: 'failure',
        event: 'local',
        execution: { _tag: 'sync', failure: 'propagate' },
        hasIdempotency: false,
        load: async () => ({ name: 'failure', event: 'local', handle: () => { throw new Error('business') } }),
      }],
    })
    await expect(createGeneratedEventRuntime(failureRegistry).dispatchEvent('local', {}, {
      observe: () => { throw new Error('observer down') },
      observerFallback: () => {},
    })).rejects.toSatisfy(error => isEventRuntimeError(error) && error._tag === 'ListenerFailure' && error.cause instanceof Error && error.cause.message === 'business')
  })

  it('uses the neutral console fallback for isolated sync and deferred failures without a host observer', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const tasks: Promise<void>[] = []
    const registry = createGeneratedEventRegistry({
      manifestHash: 'hash',
      events: [{ name: 'request:event', transport: { _tag: 'local' }, load: async () => ({ name: 'request:event', transport: { _tag: 'local' }, input: { parse: input => input } }) }],
      listeners: [
        {
          name: 'isolated-sync',
          event: 'request:event',
          execution: { _tag: 'sync', failure: 'isolate' },
          hasIdempotency: false,
          load: async () => ({ name: 'isolated-sync', event: 'request:event', execution: { _tag: 'sync', failure: 'isolate' }, handle: () => { throw new Error('sync failed') } }),
        },
        {
          name: 'isolated-deferred',
          event: 'request:event',
          execution: { _tag: 'deferred', failure: 'isolate' },
          hasIdempotency: false,
          load: async () => ({ name: 'isolated-deferred', event: 'request:event', execution: { _tag: 'deferred', failure: 'isolate' }, handle: () => { throw new Error('deferred failed') } }),
        },
      ],
    })

    await createGeneratedEventRuntime(registry).dispatchEvent('request:event', { request: true }, {
      waitUntil: (task) => { tasks.push(task) },
    })
    await Promise.all(tasks)

    expect(consoleError).toHaveBeenCalledWith('[event-listeners]', expect.objectContaining({ _tag: 'listener-failed', listenerName: 'isolated-sync' }))
    expect(consoleError).toHaveBeenCalledWith('[event-listeners]', expect.objectContaining({ _tag: 'listener-failed', listenerName: 'isolated-deferred' }))
    consoleError.mockRestore()
  })

  it('rejects stale loaded metadata and delegates queued terminal failure to the listener', async () => {
    const staleEvent = createGeneratedEventRegistry({
      manifestHash: 'hash',
      events: [{
        name: 'test:event',
        transport: { _tag: 'transfer', version: 1, maxBytes: 65_536 },
        load: async () => ({ name: 'test:event', transport: { _tag: 'transfer', version: 2 }, codec: payloadCodec }),
      }],
      listeners: [],
    })
    await expect(createGeneratedEventRuntime(staleEvent).dispatchEvent('test:event', { value: 'x' })).rejects.toSatisfy(error => isEventRuntimeError(error) && error._tag === 'RegistryDrift')

    const staleListener = createGeneratedEventRegistry({
      manifestHash: 'hash',
      events: [{ name: 'local', transport: { _tag: 'local' }, load: async () => ({ name: 'local', transport: { _tag: 'local' }, input: { parse: input => input } }) }],
      listeners: [{
        name: 'stale',
        event: 'local',
        execution: { _tag: 'sync', failure: 'propagate' },
        hasIdempotency: false,
        load: async () => ({ name: 'stale', event: 'local', execution: { _tag: 'sync', failure: 'isolate' }, handle: () => {} }),
      }],
    })
    await expect(createGeneratedEventRuntime(staleListener).dispatchEvent('local', {})).rejects.toSatisfy(error => isEventRuntimeError(error) && error._tag === 'RegistryDrift')

    const failed = vi.fn()
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
    const terminalRegistry = createGeneratedEventRegistry({
      manifestHash: 'hash',
      events: [eventEntry()],
      listeners: [{
        name: 'notify',
        event: 'test:event',
        execution: { _tag: 'queued', queue: 'notifications', publication: 'immediate' },
        hasIdempotency: true,
        hasFailed: true,
        load: async () => ({
          name: 'notify',
          event: 'test:event',
          execution: { _tag: 'queued', queue: 'notifications', publication: 'immediate' },
          idempotency: { key: () => 'notify' },
          handle: () => {},
          failed,
        }),
      }],
    })
    const terminalError = new Error('attempts exhausted')
    await createGeneratedEventRuntime(terminalRegistry).handleQueuedListenerTerminalFailure(envelope, terminalError, {
      services: undefined,
      idempotency: { run: async (_input, effect) => ({ _tag: 'executed', value: await effect() }) },
      observe: () => {},
    })
    expect(failed).toHaveBeenCalledWith({ value: 'hello' }, expect.objectContaining({ listenerName: 'notify' }), terminalError)
  })

  it('parses a queued transfer before handling and skips duplicate delivery through listener idempotency', async () => {
    const handle = vi.fn()
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
    const listenerLoad = vi.fn(async (): Promise<AnyListenerDefinition> => ({
      name: 'notify',
      event: 'test:event',
      execution: { _tag: 'queued', queue: 'notifications', publication: 'immediate' },
      idempotency: { key: payload => `notify:${payload.value}` },
      handle,
    } as AnyListenerDefinition))
    const registry = createGeneratedEventRegistry({
      manifestHash: 'hash',
      events: [eventEntry()],
      listeners: [{ name: 'notify', event: 'test:event', execution: { _tag: 'queued', queue: 'notifications', publication: 'immediate' }, hasIdempotency: true, load: listenerLoad }],
    })
    const runtime = createGeneratedEventRuntime(registry)

    await runtime.deliverQueuedListener(envelope, {
      services: undefined,
      idempotency: { run: async () => ({ _tag: 'duplicate' }) },
      observe: () => {},
    })
    expect(listenerLoad).toHaveBeenCalledOnce()
    expect(handle).not.toHaveBeenCalled()
  })

  it('evicts rejected lazy imports so development registry drift can recover', async () => {
    let attempts = 0
    const load = vi.fn(async (): Promise<AnyEventDefinition> => {
      attempts++
      if (attempts === 1)
        throw new Error('partial write')
      return { name: 'recover', transport: { _tag: 'local' }, input: { parse: input => input } }
    })
    const registry = createGeneratedEventRegistry({ manifestHash: 'hash', events: [{ name: 'recover', transport: { _tag: 'local' }, load }], listeners: [] })
    const runtime = createGeneratedEventRuntime(registry)

    await expect(runtime.dispatchEvent('recover', {})).rejects.toSatisfy(error => isEventRuntimeError(error) && error._tag === 'EventContractImportFailure')
    await expect(runtime.dispatchEvent('recover', {})).resolves.toMatchObject({ _tag: 'dispatched' })
    expect(load).toHaveBeenCalledTimes(2)
  })
})
