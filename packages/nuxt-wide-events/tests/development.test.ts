import { describe, expect, it } from 'vitest'
import { enrichDevelopmentWideEvent, formatDevelopmentWideEvent } from '../src/runtime/server/development'

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

describe('formatDevelopmentWideEvent', () => {
  it('keeps redirected output free of terminal color codes', () => {
    const isTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    const noColor = process.env.NO_COLOR
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined })
    delete process.env.NO_COLOR

    const output = (() => {
      try {
        return formatDevelopmentWideEvent({
          timestamp: '2026-08-14T08:28:15.225Z',
          level: 'info',
          method: 'GET',
          path: '/api/cart',
          status: 200,
          durationMs: 1,
          requestId: 'req_1',
        })
      }
      finally {
        if (isTTY)
          Object.defineProperty(process.stdout, 'isTTY', isTTY)
        else
          delete (process.stdout as { isTTY?: boolean }).isTTY
        if (noColor === undefined)
          delete process.env.NO_COLOR
        else
          process.env.NO_COLOR = noColor
      }
    })()

    expect(output).toBe([
      '08:28:15.225 INFO [Wide Event] GET /api/cart 200 in 1ms',
      '  └─ requestId: req_1',
    ].join('\n'))
  })

  it('renders developer messages as compact terminal blocks', () => {
    expect(formatDevelopmentWideEvent({
      scope: 'ssr',
      devMessage: 'server fetch completed\n  fetch   : GET /api/_auth/session\n  duration: 16ms\n  request : GET /',
      timestamp: '2026-08-14T08:28:15.225Z',
      level: 'debug',
      method: 'UNKNOWN',
      status: 200,
      durationMs: 0.155,
      requestId: 'req_1',
    }, { colors: false })).toBe([
      '08:28:15.225 DEBUG [ssr] server fetch completed',
      '  fetch   : GET /api/_auth/session',
      '  duration: 16ms',
      '  request : GET /',
      '  └─ requestId: req_1',
    ].join('\n'))
  })

  it('renders request metadata and Fields without object inspection noise', () => {
    expect(formatDevelopmentWideEvent({
      'timestamp': '2026-08-14T08:28:15.225Z',
      'level': 'warn',
      'service': 'shop',
      'method': 'GET',
      'path': '/api/cart',
      'status': 429,
      'durationMs': 16.4,
      'requestId': 'req_2',
      'cart.itemCount': 2,
    }, { colors: false })).toBe([
      '08:28:15.225 WARN [shop] GET /api/cart 429 in 16ms',
      '  ├─ cart.itemCount: 2',
      '  └─ requestId: req_2',
    ].join('\n'))
  })

  it('keeps request metadata for unsupported HTTP methods', () => {
    expect(formatDevelopmentWideEvent({
      timestamp: '2026-08-14T08:28:15.225Z',
      level: 'info',
      method: 'UNKNOWN',
      path: '/webdav/files',
      status: 405,
      durationMs: 2,
      requestId: 'req_3',
    }, { colors: false })).toBe([
      '08:28:15.225 INFO [Wide Event] UNKNOWN /webdav/files 405 in 2ms',
      '  └─ requestId: req_3',
    ].join('\n'))
  })
})
