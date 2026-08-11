import { describe, expect, it, vi } from 'vitest'
import {
  assertD1BoundParameters,
  chunkD1Items,
  D1_MAX_BOUND_PARAMETERS,
  defineD1ParameterPlan,
  getRequestD1Session,
  isTransientD1Error,
  retryIdempotentD1Write,
} from '../src/d1'

describe('d1 parameter budget', () => {
  it('derives safe IN-list and multi-row insert sizes from the 100-bind ceiling', () => {
    expect(D1_MAX_BOUND_PARAMETERS).toBe(100)
    expect(defineD1ParameterPlan({ parametersPerItem: 100, reservedParameters: 0 }).itemsPerStatement).toBe(1)
    expect(defineD1ParameterPlan({ parametersPerItem: 1, reservedParameters: 2 }).itemsPerStatement).toBe(98)
    expect(defineD1ParameterPlan({ parametersPerItem: 17, reservedParameters: 0 }).itemsPerStatement).toBe(5)
    expect(defineD1ParameterPlan({ parametersPerItem: 8, reservedParameters: 12 }).itemsPerStatement).toBe(11)
  })

  it('chunks every item without emitting an over-budget statement', () => {
    const items = Array.from({ length: 31 }, (_, index) => index)
    const chunks = chunkD1Items(items, defineD1ParameterPlan({ parametersPerItem: 14, reservedParameters: 0 }))

    expect(chunks.map(chunk => chunk.length)).toEqual([7, 7, 7, 7, 3])
    expect(chunks.flat()).toEqual(items)
    expect(chunks.every(chunk => chunk.length * 14 <= D1_MAX_BOUND_PARAMETERS)).toBe(true)
  })

  it('covers the 100-item bulk set and remove shapes used by site investigations', () => {
    const items = Array.from({ length: 100 }, (_, index) => index)
    const setPlan = defineD1ParameterPlan({ parametersPerItem: 4, reservedParameters: 2 })
    const removePlan = defineD1ParameterPlan({ parametersPerItem: 1, reservedParameters: 2 })
    const setChunks = chunkD1Items(items, setPlan)
    const removeChunks = chunkD1Items(items, removePlan)

    expect(setChunks.map(chunk => chunk.length)).toEqual([24, 24, 24, 24, 4])
    expect(removeChunks.map(chunk => chunk.length)).toEqual([98, 2])
    expect(setChunks.every(chunk => chunk.length * 4 + 2 <= D1_MAX_BOUND_PARAMETERS)).toBe(true)
    expect(removeChunks.every(chunk => chunk.length + 2 <= D1_MAX_BOUND_PARAMETERS)).toBe(true)
  })

  it.each([
    { parametersPerItem: 0, reservedParameters: 0 },
    { parametersPerItem: 1.5, reservedParameters: 0 },
    { parametersPerItem: Number.NaN, reservedParameters: 0 },
    { parametersPerItem: Number.POSITIVE_INFINITY, reservedParameters: 0 },
    { parametersPerItem: 101, reservedParameters: 0 },
    { parametersPerItem: 1, reservedParameters: -1 },
    { parametersPerItem: 1, reservedParameters: 100 },
  ])('rejects an impossible parameter budget: %j', (budget) => {
    expect(() => defineD1ParameterPlan(budget)).toThrow(TypeError)
  })

  it('returns no chunks for an empty input while retaining the parsed plan', () => {
    const plan = defineD1ParameterPlan({ parametersPerItem: 1, reservedParameters: 0 })
    expect(chunkD1Items([], plan)).toEqual([])
    expect(plan.itemsPerStatement).toBe(100)
  })

  it('rejects a forged runtime plan instead of looping on an invalid size', () => {
    expect(() => chunkD1Items([1], { itemsPerStatement: 0 } as never))
      .toThrow(/defineD1ParameterPlan/)
  })

  it('asserts the emitted parameter count at the query boundary', () => {
    expect(() => assertD1BoundParameters(Array.from({ length: 100 }))).not.toThrow()
    expect(() => assertD1BoundParameters(Array.from({ length: 101 }))).toThrow(/101 bound parameters/)
    expect(() => assertD1BoundParameters('not-an-array' as never)).toThrow(/must be an array/)
  })
})

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

  it.each([
    'D1 DB is overloaded. Requests queued for too long.',
    'D1 DB storage operation exceeded timeout which caused object to be reset.',
    'D1 DB\'s isolate exceeded its memory limit and was reset.',
    'D1 DB exceeded its CPU time limit and was reset.',
  ])('does not amplify resource pressure by retrying: %s', async (message) => {
    const error = new Error(`D1_ERROR: ${message}`)
    const run = vi.fn().mockRejectedValue(error)

    await expect(retryIdempotentD1Write({ safety: { _tag: 'replay-safe' }, run })).rejects.toBe(error)
    expect(run).toHaveBeenCalledOnce()
    expect(isTransientD1Error(error)).toBe(false)
  })

  it('classifies mixed-case transient errors nested in a cause', () => {
    expect(isTransientD1Error(new Error('wrapper', {
      cause: new Error('D1_ERROR: NETWORK CONNECTION LOST'),
    }))).toBe(true)
  })

  it('retries a synchronous lock failure', async () => {
    const run = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('database is locked')
      })
      .mockResolvedValue('ok')

    await expect(retryIdempotentD1Write({
      safety: { _tag: 'lock-only' },
      run,
      sleep: async () => {},
    })).resolves.toBe('ok')
    expect(run).toHaveBeenCalledTimes(2)
  })
})
