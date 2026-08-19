import type { WideEventRecord } from '../src/runtime/server/index'
import { describe, expect, it } from 'vitest'
import { shouldEmitWideEvent } from '../src/runtime/server/production-policy'

const record: WideEventRecord = {
  durationMs: 10,
  kind: 'request',
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

  it('applies the rate that matches the record level', () => {
    expect(shouldEmitWideEvent({ ...record, level: 'warn' }, { info: 100, warn: 0 }, () => 0)).toBe(false)
    expect(shouldEmitWideEvent({ ...record, level: 'debug' }, { debug: 0, info: 100 }, () => 0)).toBe(false)
    expect(shouldEmitWideEvent({ ...record, level: 'error' }, {}, () => 1)).toBe(true)
  })

  it('keeps a record that matches one whole condition', () => {
    const sampling = { error: 0, info: 0, keep: [{ duration: 1000 }, { status: 400 }] }

    expect(shouldEmitWideEvent({ ...record, durationMs: 1000 }, sampling, () => 1)).toBe(true)
    expect(shouldEmitWideEvent({ ...record, status: 400 }, sampling, () => 1)).toBe(true)
    expect(shouldEmitWideEvent(record, sampling, () => 0)).toBe(false)
  })

  it('requires every part of one condition', () => {
    const sampling = { info: 0, keep: [{ duration: 1000, status: 500 }] }

    expect(shouldEmitWideEvent({ ...record, durationMs: 1000, status: 500 }, sampling, () => 0)).toBe(true)
    expect(shouldEmitWideEvent({ ...record, durationMs: 1000 }, sampling, () => 0)).toBe(false)
    expect(shouldEmitWideEvent({ ...record, status: 500 }, sampling, () => 0)).toBe(false)
  })
})
