import { describe, expect, it, vi } from 'vitest'
import { enrichDevelopmentWideEvent, formatDevelopmentWideEvent, writeDevelopmentWideEvent } from '../src/runtime/server/development'

describe('enrichDevelopmentWideEvent', () => {
  it('adds error details only to a development record', () => {
    const record = {
      'timestamp': 'now',
      'kind': 'request' as const,
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
  it('uses a subtle pastel palette for request syntax', () => {
    const blue = '\u001B[38;2;137;180;250m'
    const green = '\u001B[38;2;166;227;161m'
    const mauve = '\u001B[38;2;203;166;247m'
    const muted = '\u001B[38;2;147;153;178m'
    const reset = '\u001B[0m'
    const teal = '\u001B[38;2;148;226;213m'

    expect(formatDevelopmentWideEvent({
      'timestamp': '2026-08-14T08:28:15.225Z',
      'kind': 'request',
      'level': 'info',
      'service': 'shop',
      'method': 'GET',
      'path': '/cart',
      'status': 200,
      'durationMs': 2,
      'requestId': 'req_1',
      'cf.colo': 'SYD',
    }, { colors: true })).toBe(
      `${blue}INFO${reset} ${mauve}[shop]${reset} ${blue}GET${reset} /cart ${green}200${reset} ${muted}2ms${reset} ${muted}·${reset} ${teal}cf:${reset} ${blue}colo${reset}${muted}=${reset}SYD ${muted}·${reset} ${teal}requestId:${reset} req_1`,
    )
  })

  it('keeps successful request output compact', () => {
    expect(formatDevelopmentWideEvent({
      'timestamp': '2026-08-14T08:28:15.225Z',
      'kind': 'request',
      'level': 'info',
      'service': 'nuxtseo-pro',
      'method': 'GET',
      'path': '/**',
      'status': 200,
      'durationMs': 144,
      'requestId': '7d24a411-02f4-4a8d-b5b7-353d937cd0a4',
      'cf.colo': 'SYD',
      'cf.country': 'AU',
      'cf.httpProtocol': 'HTTP/1.1',
      'd1.queries': null,
      'd1.durationMs': null,
    }, { colors: false })).toBe([
      'INFO [nuxtseo-pro] GET /** 200 144ms · cf: colo=SYD, country=AU, httpProtocol=HTTP/1.1 · requestId: 7d24a411-02f4-4a8d-b5b7-353d937cd0a4',
    ].join('\n'))
  })

  it('keeps redirected output free of terminal color codes', () => {
    const isTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    const noColor = process.env.NO_COLOR
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined })
    delete process.env.NO_COLOR

    const output = (() => {
      try {
        return formatDevelopmentWideEvent({
          timestamp: '2026-08-14T08:28:15.225Z',
          kind: 'request',
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
      'INFO [Wide Event] GET /api/cart 200 1ms · requestId: req_1',
    ].join('\n'))
  })

  it('keeps terminal colors through a worker console transport', () => {
    vi.stubGlobal('process', { env: {}, stdout: undefined })

    const output = (() => {
      try {
        return formatDevelopmentWideEvent({
          timestamp: '2026-08-14T08:28:15.225Z',
          kind: 'request',
          level: 'info',
          method: 'GET',
          path: '/api/cart',
          status: 200,
          durationMs: 1,
          requestId: 'req_1',
        })
      }
      finally {
        vi.unstubAllGlobals()
      }
    })()

    expect(output).toContain('\u001B[38;2;137;180;250mINFO\u001B[0m')
  })

  it('renders a background developer message as a compact terminal block', () => {
    expect(formatDevelopmentWideEvent({
      scope: 'ssr',
      devMessage: 'server fetch completed\n  fetch   : GET /api/_auth/session\n  duration: 16ms\n  request : GET /',
      timestamp: '2026-08-14T08:28:15.225Z',
      kind: 'background',
      level: 'debug',
      durationMs: 0.155,
      requestId: 'req_1',
    }, { colors: false })).toBe([
      'DEBUG [ssr] server fetch completed · requestId: req_1',
      '  fetch   : GET /api/_auth/session',
      '  duration: 16ms',
      '  request : GET /',
    ].join('\n'))
  })

  it('renders request metadata and Fields without object inspection noise', () => {
    expect(formatDevelopmentWideEvent({
      'timestamp': '2026-08-14T08:28:15.225Z',
      'kind': 'request',
      'level': 'warn',
      'service': 'shop',
      'method': 'GET',
      'path': '/api/cart',
      'status': 429,
      'durationMs': 16.4,
      'requestId': 'req_2',
      'cart.itemCount': 2,
      'cart.total': 40,
    }, { colors: false })).toBe([
      'WARN [shop] GET /api/cart 429 16ms · requestId: req_2',
      '  └─ cart: itemCount=2, total=40',
    ].join('\n'))
  })

  it('keeps request metadata for unsupported HTTP methods', () => {
    expect(formatDevelopmentWideEvent({
      timestamp: '2026-08-14T08:28:15.225Z',
      kind: 'request',
      level: 'info',
      method: 'UNKNOWN',
      path: '/webdav/files',
      status: 405,
      durationMs: 2,
      requestId: 'req_3',
    }, { colors: false })).toBe([
      'INFO [Wide Event] UNKNOWN /webdav/files 405 2ms · requestId: req_3',
    ].join('\n'))
  })
})

describe('writeDevelopmentWideEvent', () => {
  it('uses the app console so Nuxt can attribute the log to its request', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    let consoleCalls = 0
    let stdoutCalls = 0

    try {
      writeDevelopmentWideEvent({
        timestamp: '2026-08-14T08:28:15.225Z',
        kind: 'request',
        level: 'info',
        method: 'GET',
        path: '/api/cart',
        status: 200,
        durationMs: 1,
        requestId: 'req_1',
      })
    }
    finally {
      consoleCalls = consoleLog.mock.calls.length
      stdoutCalls = stdoutWrite.mock.calls.length
      consoleLog.mockRestore()
      stdoutWrite.mockRestore()
    }

    expect(consoleCalls).toBe(1)
    expect(stdoutCalls).toBe(0)
  })
})
