import { describe, expect, it, vi } from 'vitest'
import { parseFailedJobEnvelope, redispatchFailedJob } from '#cf-jobs/server'

describe('parseFailedJobEnvelope', () => {
  it('recovers the job name and clean input from a stored envelope', () => {
    const json = JSON.stringify({ _task: 'pro:refresh-keywords', siteId: 's_1', limit: 50 })
    expect(parseFailedJobEnvelope(json)).toEqual({
      _tag: 'ok',
      name: 'pro:refresh-keywords',
      payload: { siteId: 's_1', limit: 50 },
    })
  })

  it('drops internal `_continuations` so a manual retry cannot double-fire onFinish', () => {
    const json = JSON.stringify({ _task: 'a', x: 1, _continuations: [{ _task: 'b' }] })
    const result = parseFailedJobEnvelope(json)
    expect(result).toEqual({ _tag: 'ok', name: 'a', payload: { x: 1 } })
  })

  it('flags a payload with no `_task` as not retryable', () => {
    expect(parseFailedJobEnvelope(JSON.stringify({ x: 1 }))).toEqual({ _tag: 'no-task' })
    expect(parseFailedJobEnvelope(JSON.stringify({ _task: '', x: 1 }))).toEqual({ _tag: 'no-task' })
  })

  it('flags non-object / malformed JSON', () => {
    expect(parseFailedJobEnvelope('not json')).toEqual({ _tag: 'invalid-json' })
    expect(parseFailedJobEnvelope('null')).toEqual({ _tag: 'invalid-json' })
    expect(parseFailedJobEnvelope('42')).toEqual({ _tag: 'invalid-json' })
  })
})

describe('redispatchFailedJob', () => {
  it('re-enqueues a fresh job then forgets the failed row', async () => {
    const enqueue = vi.fn(async () => 'job_new')
    const forget = vi.fn(async () => {})
    const result = await redispatchFailedJob({
      loadFailure: async () => ({ payload: JSON.stringify({ _task: 'pro:scan', siteId: 's_1' }) }),
      enqueue,
      forget,
    })
    expect(result).toEqual({ _tag: 'redispatched', name: 'pro:scan', jobId: 'job_new' })
    expect(enqueue).toHaveBeenCalledWith('pro:scan', { siteId: 's_1' })
    expect(forget).toHaveBeenCalledOnce()
  })

  it('returns not-found without enqueueing when the row is absent', async () => {
    const enqueue = vi.fn()
    const forget = vi.fn()
    const result = await redispatchFailedJob({ loadFailure: async () => null, enqueue, forget })
    expect(result).toEqual({ _tag: 'not-found' })
    expect(enqueue).not.toHaveBeenCalled()
    expect(forget).not.toHaveBeenCalled()
  })

  it('returns not-retryable for a payload without `_task`, leaving the row in place', async () => {
    const enqueue = vi.fn()
    const forget = vi.fn()
    const result = await redispatchFailedJob({
      loadFailure: async () => ({ payload: JSON.stringify({ x: 1 }) }),
      enqueue,
      forget,
    })
    expect(result).toEqual({ _tag: 'not-retryable' })
    expect(enqueue).not.toHaveBeenCalled()
    expect(forget).not.toHaveBeenCalled()
  })

  it('does NOT forget the failed row when re-enqueue throws', async () => {
    const forget = vi.fn()
    await expect(redispatchFailedJob({
      loadFailure: async () => ({ payload: JSON.stringify({ _task: 'a' }) }),
      enqueue: async () => { throw new Error('dispatch dropped') },
      forget,
    })).rejects.toThrow('dispatch dropped')
    expect(forget).not.toHaveBeenCalled()
  })
})
