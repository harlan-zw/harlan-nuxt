import type { LazyJobEntry } from '../src/runtime/server/registry'
import { describe, expect, it, vi } from 'vitest'
import { dispatchRegisteredJob } from '../src/runtime/server/dispatch'
import { prepareRegisteredDurableJob } from '../src/runtime/server/outbox'
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

  it('evicts a rejected lazy import so a later dispatch can retry it', async () => {
    const handle = vi.fn(async () => {})
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('transient chunk failure'))
      .mockResolvedValueOnce(defineJob({
        name: 'indexing/retry-import',
        queue: 'critical',
        handle,
      }))
    const registry = defineJobRegistry([{
      name: 'indexing/retry-import',
      queue: 'critical',
      load,
    } as LazyJobEntry])

    await expect(registry.loadJobDefinition('indexing/retry-import')).rejects.toThrow('transient chunk failure')
    await expect(registry.loadJobDefinition('indexing/retry-import')).resolves.toMatchObject({
      name: 'indexing/retry-import',
    })

    expect(load).toHaveBeenCalledTimes(2)
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

    expect(result.error?._tag).toBe('handler-not-found')
    expect(load).not.toHaveBeenCalled()
  })

  it('loads the full definition for producer-side payload validation', async () => {
    const input = {
      safeParse(payload: unknown) {
        return payload && typeof payload === 'object' && typeof (payload as { id?: unknown }).id === 'string'
          ? { success: true as const, data: payload as { id: string } }
          : { success: false as const, error: new Error('id required') }
      },
    }
    const load = vi.fn(async () => defineJob({
      name: 'indexing/persist',
      queue: 'default',
      input,
      async handle() {},
    }))
    const registry = defineJobRegistry([{
      name: 'indexing/persist',
      queue: 'default',
      hasInput: true,
      load,
    } as LazyJobEntry] as never)

    await expect(prepareRegisteredDurableJob(registry, {
      name: 'indexing/persist',
      payload: { missing: true },
    } as never)).rejects.toMatchObject({
      jobError: { _tag: 'invalid-payload' },
    })

    expect(load).toHaveBeenCalledOnce()
  })

  it('loads and caches custom uniqueId logic on the producer path', async () => {
    const load = vi.fn(async () => defineJob({
      name: 'indexing/persist',
      queue: 'default',
      unique: true,
      uniqueId: (payload: { id: string }) => payload.id,
      async handle() {},
    }))
    const registry = defineJobRegistry([{
      name: 'indexing/persist',
      queue: 'default',
      unique: true,
      hasUniqueId: true,
      load,
    } as LazyJobEntry] as never)

    const first = await prepareRegisteredDurableJob(registry, {
      name: 'indexing/persist',
      payload: { id: 'same', attempt: 1 },
    } as never)
    const second = await prepareRegisteredDurableJob(registry, {
      name: 'indexing/persist',
      payload: { id: 'same', attempt: 2 },
    } as never)

    expect(first.uniqueKey).toBe(second.uniqueKey)
    expect(load).toHaveBeenCalledOnce()
  })
})
