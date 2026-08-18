import type { NitroApp } from 'nitropack/types'
import type { WideEventRecord } from '../src/runtime/server/index'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduleWideEventDrain } from '../src/runtime/server/drain'

afterEach(() => {
  vi.restoreAllMocks()
})

const record: WideEventRecord = {
  durationMs: 10,
  kind: 'request',
  level: 'error',
  method: 'GET',
  requestId: 'req_1',
  status: 500,
  timestamp: '2026-08-13T00:00:00.000Z',
}

function nitroApp(hook: () => Promise<void>): NitroApp {
  return {
    hooks: {
      callHookParallel: () => hook(),
    },
  } as unknown as NitroApp
}

describe('scheduleWideEventDrain', () => {
  it('reports the failure that stopped the drain', async () => {
    const error = new Error('D1 unavailable')
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const pending: Promise<unknown>[] = []

    scheduleWideEventDrain(
      nitroApp(() => Promise.reject(error)),
      { waitUntil: promise => pending.push(promise) },
      record,
    )
    await Promise.all(pending)

    expect(reported).toHaveBeenCalledWith('[nuxt-wide-events] Wide Event drain failed.', error)
  })

  it('waits for the drain before the request ends', async () => {
    let drained = false
    const pending: Promise<unknown>[] = []

    scheduleWideEventDrain(
      nitroApp(async () => {
        await Promise.resolve()
        drained = true
      }),
      { waitUntil: promise => pending.push(promise) },
      record,
    )

    expect(drained).toBe(false)
    await Promise.all(pending)
    expect(drained).toBe(true)
  })
})
