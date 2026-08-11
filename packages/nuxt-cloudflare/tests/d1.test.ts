import { describe, expect, it, vi } from 'vitest'
import { getRequestD1Session, isTransientD1Error, retryIdempotentD1Write } from '../src/d1'

describe('getRequestD1Session', () => {
  it('creates one first-primary session per request and binding', () => {
    const session = { marker: 'session' }
    const database = { withSession: vi.fn(() => session) }
    const context = {}

    expect(getRequestD1Session(context, 'DB', database)).toBe(session)
    expect(getRequestD1Session(context, 'DB', database)).toBe(session)
    expect(database.withSession).toHaveBeenCalledOnce()
    expect(database.withSession).toHaveBeenCalledWith('first-primary')
  })
})

describe('retryIdempotentD1Write', () => {
  it('retries only a write explicitly tagged replay-safe', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('D1_ERROR: Network connection lost'))
      .mockResolvedValue('ok')
    const sleep = vi.fn(async () => {})

    await expect(retryIdempotentD1Write({
      safety: { _tag: 'replay-safe' },
      run,
      sleep,
      random: () => 0.5,
    })).resolves.toBe('ok')
    expect(run).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledOnce()
  })

  it('does not retry terminal D1 failures', async () => {
    const error = new Error('D1_ERROR: UNIQUE constraint failed')
    const run = vi.fn().mockRejectedValue(error)

    await expect(retryIdempotentD1Write({ safety: { _tag: 'replay-safe' }, run })).rejects.toBe(error)
    expect(run).toHaveBeenCalledOnce()
    expect(isTransientD1Error(error)).toBe(false)
  })
})
