import { describe, expect, it } from 'vitest'
import { enrichDevelopmentWideEvent } from '../src/runtime/server/development'

describe('enrichDevelopmentWideEvent', () => {
  it('adds error details only to a development record', () => {
    const record = {
      'timestamp': 'now',
      'level': 'error' as const,
      'method': 'GET',
      'path': '/',
      'status': 500,
      'durationMs': 1,
      'requestId': 'req_1',
      'error.name': 'Error',
    }
    const error = new Error('Database unavailable')

    expect(enrichDevelopmentWideEvent(record, error)).toEqual(expect.objectContaining({
      'error.message': 'Database unavailable',
      'error.stack': expect.stringContaining('Database unavailable'),
    }))
  })
})
