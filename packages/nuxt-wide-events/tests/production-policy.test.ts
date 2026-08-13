import type { WideEventRecord } from '../src/runtime/server/index'
import { describe, expect, it } from 'vitest'
import { shouldEmitWideEvent } from '../src/runtime/server/production-policy'

const record: WideEventRecord = {
  durationMs: 10,
  level: 'info',
  method: 'GET',
  requestId: 'req_1',
  status: 200,
  timestamp: '2026-08-13T00:00:00.000Z',
}

describe('shouldEmitWideEvent', () => {
  it('applies the configured percentage', () => {
    const sampling = { info: 10 }

    expect(shouldEmitWideEvent(record, sampling, () => 0.09)).toBe(true)
    expect(shouldEmitWideEvent(record, sampling, () => 0.1)).toBe(false)
    expect(shouldEmitWideEvent(record, { info: 0 }, () => 0)).toBe(false)
    expect(shouldEmitWideEvent(record, { info: 100 }, () => 1)).toBe(true)
  })

  it('keeps matching duration or status before applying the rate', () => {
    const sampling = { duration: 1000, error: 0, info: 0, status: 400 }

    expect(shouldEmitWideEvent({ ...record, durationMs: 1000 }, sampling, () => 1)).toBe(true)
    expect(shouldEmitWideEvent({ ...record, status: 400 }, sampling, () => 1)).toBe(true)
    expect(shouldEmitWideEvent(record, sampling, () => 0)).toBe(false)
    expect(shouldEmitWideEvent({ ...record, level: 'error' }, {}, () => 1)).toBe(true)
  })
})
