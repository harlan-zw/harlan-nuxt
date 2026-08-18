import type { AnyListenerDefinition, GeneratedListenerEntry } from '../src/runtime/server/types'
import { describe, expect, it, vi } from 'vitest'
import { createGeneratedEventRegistry } from '../src/runtime/server/registry'
import { createGeneratedEventRuntime } from '../src/runtime/server/runtime'

function deferredListener(name: string, handle: AnyListenerDefinition['handle']): GeneratedListenerEntry {
  const execution = { _tag: 'deferred', failure: 'isolate' } as const
  return {
    name,
    event: 'request:event',
    execution,
    hasIdempotency: false,
    load: async () => ({ name, event: 'request:event', execution, handle } as AnyListenerDefinition),
  }
}

function registryWith(listeners: GeneratedListenerEntry[]) {
  return createGeneratedEventRegistry({
    manifestHash: 'hash',
    events: [{
      name: 'request:event',
      transport: { _tag: 'local' },
      load: async () => ({ name: 'request:event', transport: { _tag: 'local' }, input: { parse: input => input } }),
    }],
    listeners,
  })
}

describe('dispatchEventAndDrain', () => {
  it('awaits deferred listeners when the host has no waitUntil', async () => {
    const trace: string[] = []
    const runtime = createGeneratedEventRuntime(registryWith([
      deferredListener('slow', async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
        trace.push('deferred')
      }),
    ]))

    const report = await runtime.dispatchEventAndDrain('request:event', { request: true })

    expect(trace).toEqual(['deferred'])
    expect(report.deferredScheduled).toEqual(['slow'])
  })

  it('hands deferred listeners to the host waitUntil instead of awaiting them', async () => {
    const tasks: Promise<void>[] = []
    const trace: string[] = []
    const runtime = createGeneratedEventRuntime(registryWith([
      deferredListener('slow', async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
        trace.push('deferred')
      }),
    ]))

    await runtime.dispatchEventAndDrain('request:event', { request: true }, {
      waitUntil: task => void tasks.push(task),
    })

    expect(trace).toEqual([])
    expect(tasks).toHaveLength(1)
    await Promise.all(tasks)
    expect(trace).toEqual(['deferred'])
  })

  it('drains scheduled deferred listeners before rethrowing a dispatch failure', async () => {
    const observe = vi.fn()
    const runtime = createGeneratedEventRuntime(registryWith([
      deferredListener('isolated', () => {
        throw new Error('deferred failed')
      }),
    ]))

    await runtime.dispatchEventAndDrain('request:event', { request: true }, { observe })

    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ _tag: 'listener-failed', listenerName: 'isolated', isolated: true }))
  })
})
