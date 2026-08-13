import { afterEach, describe, expect, it, vi } from 'vitest'
import { addWideEventFields } from '../src/runtime/server/index'
import { createWideEvent } from '../src/runtime/server/standalone'
import { createDrainedStandaloneWideEvent, createStandaloneWideEvent } from '../src/runtime/server/standalone-core'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('standalone Wide Event', () => {
  it('collects configured Fields and writes one JSON record', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const wideEvent = createWideEvent({
      'job.id': 'job_1',
      'job.skipped': undefined,
    } as never)

    addWideEventFields(wideEvent, { 'job.outcome': 'completed' } as never)
    wideEvent.setLevel('warn')
    const record = wideEvent.emit()

    expect(record).toEqual(expect.objectContaining({
      'job.id': 'job_1',
      'job.outcome': 'completed',
      'level': 'warn',
    }))
    expect(Object.hasOwn(record!, 'job.skipped')).toBe(false)
    expect(output).toHaveBeenCalledOnce()
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(record)
  })

  it('emits only once and rejects later Field mutation', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const wideEvent = createWideEvent()

    expect(wideEvent.emit()).not.toBeNull()
    expect(wideEvent.emit()).toBeNull()
    expect(() => addWideEventFields(wideEvent, { 'job.id': 'late' } as never)).toThrow(/already emitted/)
  })

  it('rejects a non-primitive Field before output', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    expect(() => createWideEvent({ 'job.data': { token: 'secret' } } as never)).toThrow(/must be a string/)
    expect(output).not.toHaveBeenCalled()
  })

  it('rejects a level change after output', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const wideEvent = createWideEvent()
    wideEvent.emit()

    expect(() => wideEvent.setLevel('error')).toThrow(/already emitted/)
  })

  it('rejects an unknown level before output', () => {
    const wideEvent = createWideEvent()

    expect(() => wideEvent.setLevel('secret' as never)).toThrow(/level must be/)
  })

  it('copies initial Fields before later caller mutation', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const fields = { 'job.id': 'job_1' } as never
    const wideEvent = createWideEvent(fields)
    ;(fields as { 'job.id': string })['job.id'] = 'changed'

    expect(wideEvent.emit()).toEqual(expect.objectContaining({ 'job.id': 'job_1' }))
  })

  it('applies standalone levels and emits an object to development output', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const output = vi.fn()
    const sampled = createStandaloneWideEvent(undefined, {
      output,
      sampling: { debug: 0, warn: 100 },
      service: 'worker',
    })
    sampled.setLevel('debug')

    expect(sampled.emit()).toBeNull()
    expect(output).not.toHaveBeenCalled()

    const kept = createStandaloneWideEvent(undefined, {
      output,
      sampling: { warn: 100 },
      service: 'worker',
    })
    kept.setLevel('warn')

    expect(kept.emit()).toEqual(expect.objectContaining({ level: 'warn', service: 'worker' }))
    expect(output).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', service: 'worker' }))
  })

  it('waits for asynchronous drain output before resolving', async () => {
    let finishDrain: (() => void) | undefined
    const wideEvent = createDrainedStandaloneWideEvent(undefined, {
      output: () => new Promise<void>((resolve) => {
        finishDrain = resolve
      }),
    })

    const pending = wideEvent.emit()
    let settled = false
    void pending.then(() => settled = true)
    await Promise.resolve()

    expect(settled).toBe(false)
    finishDrain!()
    await pending
    expect(settled).toBe(true)
  })

  it('surfaces asynchronous drain failures', async () => {
    const wideEvent = createDrainedStandaloneWideEvent(undefined, {
      output: async () => {
        throw new Error('D1 unavailable')
      },
    })

    await expect(wideEvent.emit()).rejects.toThrow('D1 unavailable')
  })
})
