import type { LazyJobEntry } from '../src/runtime/server/registry'
import { describe, expect, it, vi } from 'vitest'
import { dispatchRegisteredJob } from '../src/runtime/server/dispatch'
import { defineJob, defineJobRegistry } from '../src/runtime/server/registry'

// A lazy entry mirrors what the generated `registry.ts` emits: static routing
// metadata + a `load()` that imports the handler module on demand.
function lazyEntry(name: string, queue: string, handle = vi.fn(async () => {})) {
  const load = vi.fn(async () => defineJob({ name, queue, handle }))
  return { entry: { name, queue, load } as LazyJobEntry, load, handle }
}

describe('lazy registry entries', () => {
  it('resolves routing metadata WITHOUT loading the handler module', () => {
    const { entry, load } = lazyEntry('sync/table', 'standard')
    const registry = defineJobRegistry([entry])

    expect(registry.getJobQueue('sync/table')).toBe('standard')
    expect(registry.getJobRoute('sync/table')).toEqual({ queue: 'standard', jobType: 'sync/table' })
    expect(registry.getJobDefinition('sync/table')?.queue).toBe('standard')
    // The whole point: none of the above imported the job module.
    expect(load).not.toHaveBeenCalled()
  })

  it('getHandler loads on demand and loadJobDefinition caches (one import per job)', async () => {
    const { entry, load, handle } = lazyEntry('indexing/check', 'critical')
    const registry = defineJobRegistry([entry])

    const handler = await registry.getHandler('indexing/check')
    expect(handler).toBe(handle)
    expect(load).toHaveBeenCalledTimes(1)

    await registry.loadJobDefinition('indexing/check')
    await registry.getHandler('indexing/check')
    // Cached — still a single import.
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('dispatches a lazy job through the loaded handler', async () => {
    const ran: unknown[] = []
    const handle = vi.fn(async (payload: unknown) => {
      ran.push(payload)
    })
    const { entry, load } = lazyEntry('webhook/send', 'webhook', handle)
    const registry = defineJobRegistry([entry])

    const result = await dispatchRegisteredJob({
      registry,
      job: { id: 'j1', queue: 'webhook', payload: { _task: 'webhook/send', url: 'https://x' }, attempts: 0, batchId: null },
      createContext: () => ({}) as never,
    })

    expect(result.success).toBe(true)
    expect(load).toHaveBeenCalledTimes(1)
    expect(ran).toEqual([{ url: 'https://x' }])
  })

  it('reports handlerNotFound for an unknown task without loading anything', async () => {
    const { entry, load } = lazyEntry('a/b', 'q')
    const registry = defineJobRegistry([entry])

    const result = await dispatchRegisteredJob({
      registry,
      job: { id: 'j2', queue: 'q', payload: { _task: 'missing/task' }, attempts: 0, batchId: null },
      createContext: () => ({}) as never,
    })

    expect(result.handlerNotFound).toBe(true)
    expect(load).not.toHaveBeenCalled()
  })
})
