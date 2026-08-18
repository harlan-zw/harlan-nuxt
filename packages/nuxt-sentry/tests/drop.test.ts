import type { ErrorReport, ReportPolicy } from '../src/runtime/shared/types'
import { describe, expect, it } from 'vitest'
import { resolveReportPolicy } from '../src/build/policy'
import {
  decideReport,
  errorChain,
  errorStatusCode,
  isTransientError,
  matchesStatus,
} from '../src/runtime/shared/drop'

function policy(scope: 'client' | 'server', options = {}): ReportPolicy {
  return resolveReportPolicy({ scope, dataCollection: 'scrubbed', options })
}

const emptyReport: ErrorReport = {}

describe('errorStatusCode', () => {
  it('reads statusCode from an H3 error', () => {
    expect(errorStatusCode({ statusCode: 404 })).toBe(404)
  })

  it('reads status from a fetch failure', () => {
    expect(errorStatusCode({ status: 503 })).toBe(503)
  })

  it('reads data.statusCode from a serialised Nuxt error', () => {
    expect(errorStatusCode({ data: { statusCode: 401 } })).toBe(401)
  })

  it('reads response.status from an ofetch error', () => {
    expect(errorStatusCode({ response: { status: 429 } })).toBe(429)
  })

  it('walks the cause chain to find the status', () => {
    expect(errorStatusCode({ message: 'wrapped', cause: { cause: { statusCode: 403 } } })).toBe(403)
  })

  it('returns undefined when no link carries a status', () => {
    expect(errorStatusCode(new Error('boom'))).toBeUndefined()
  })

  it('stops on a cyclic cause chain', () => {
    const error: Record<string, unknown> = { message: 'loop' }
    error.cause = error
    expect(errorChain(error)).toHaveLength(1)
    expect(errorStatusCode(error)).toBeUndefined()
  })
})

describe('matchesStatus', () => {
  it('matches a single status and an inclusive range', () => {
    expect(matchesStatus(404, [{ from: 404, to: 404 }])).toBe(true)
    expect(matchesStatus(499, [{ from: 400, to: 499 }])).toBe(true)
    expect(matchesStatus(500, [{ from: 400, to: 499 }])).toBe(false)
  })

  it('never matches when the error carries no status', () => {
    expect(matchesStatus(undefined, [{ from: 100, to: 599 }])).toBe(false)
  })
})

describe('isTransientError', () => {
  it('matches TimeoutError and AbortError by name, through the cause chain', () => {
    expect(isTransientError({ name: 'TimeoutError' })).toBe(true)
    expect(isTransientError({ message: 'wrapped', cause: { name: 'AbortError' } })).toBe(true)
  })

  it('matches the abort message patterns', () => {
    expect(isTransientError(new Error('The operation was aborted due to timeout'))).toBe(true)
    expect(isTransientError(new Error('signal is aborted without reason'))).toBe(true)
  })

  it('leaves an ordinary error alone', () => {
    expect(isTransientError(new Error('Cannot read properties of undefined'))).toBe(false)
  })
})

describe('decideReport, server defaults', () => {
  const server = policy('server')

  it('drops a 404', () => {
    expect(decideReport(emptyReport, { statusCode: 404 }, server)).toEqual({ _tag: 'drop', rule: 'status' })
  })

  it('keeps a 401, so an auth regression stays visible', () => {
    expect(decideReport(emptyReport, { statusCode: 401 }, server)).toEqual({ _tag: 'send' })
  })

  it('keeps a 403', () => {
    expect(decideReport(emptyReport, { statusCode: 403 }, server)).toEqual({ _tag: 'send' })
  })

  it('keeps a 429, so a rate limit spike stays visible', () => {
    expect(decideReport(emptyReport, { statusCode: 429 }, server)).toEqual({ _tag: 'send' })
  })

  it('keeps a 500', () => {
    expect(decideReport(emptyReport, { statusCode: 500 }, server)).toEqual({ _tag: 'send' })
  })

  it('drops a transient upstream timeout', () => {
    expect(decideReport(emptyReport, { name: 'TimeoutError' }, server)).toEqual({ _tag: 'drop', rule: 'transient' })
  })
})

describe('decideReport, client defaults', () => {
  const client = policy('client')

  it('drops 401, 403 and 404, which are an expired session racing a redirect', () => {
    for (const status of [401, 403, 404])
      expect(decideReport(emptyReport, { statusCode: status }, client)).toEqual({ _tag: 'drop', rule: 'status' })
  })

  it('keeps a 500', () => {
    expect(decideReport(emptyReport, { statusCode: 500 }, client)).toEqual({ _tag: 'send' })
  })

  it('drops a stale chunk load by message', () => {
    const report: ErrorReport = {
      exception: { values: [{ type: 'TypeError', value: 'Failed to fetch dynamically imported module: /_nuxt/x.js' }] },
    }
    expect(decideReport(report, undefined, client)).toEqual({ _tag: 'drop', rule: 'ignore-message' })
  })

  it('drops a ResizeObserver loop notice', () => {
    const report: ErrorReport = { message: 'ResizeObserver loop completed with undelivered notifications.' }
    expect(decideReport(report, undefined, client)).toEqual({ _tag: 'drop', rule: 'ignore-message' })
  })

  it('drops a report whose every frame is a browser extension', () => {
    const report: ErrorReport = {
      exception: {
        values: [{
          type: 'TypeError',
          value: 'x is not a function',
          stacktrace: { frames: [{ filename: 'chrome-extension://abc/content.js' }] },
        }],
      },
    }
    expect(decideReport(report, undefined, client)).toEqual({ _tag: 'drop', rule: 'deny-url' })
  })

  it('keeps a report with one site frame among extension frames', () => {
    const report: ErrorReport = {
      exception: {
        values: [{
          type: 'TypeError',
          value: 'x is not a function',
          stacktrace: {
            frames: [
              { filename: 'chrome-extension://abc/content.js' },
              { filename: 'https://harlanzw.com/_nuxt/app.js' },
            ],
          },
        }],
      },
    }
    expect(decideReport(report, undefined, client)).toEqual({ _tag: 'send' })
  })

  it('keeps a genuine application error', () => {
    const report: ErrorReport = {
      exception: { values: [{ type: 'TypeError', value: 'Cannot read properties of undefined (reading id)' }] },
    }
    expect(decideReport(report, undefined, client)).toEqual({ _tag: 'send' })
  })
})

describe('decideReport, site rules', () => {
  it('drops a site declared message pattern', () => {
    const site = policy('server', { ignoreErrors: [/^Failed to (?:fetch|read) https?:\/\/\S+$/] })
    const report: ErrorReport = { message: 'Failed to fetch https://npmjs.org/x' }
    expect(decideReport(report, undefined, site)).toEqual({ _tag: 'drop', rule: 'ignore-message' })
  })

  it('drops a site declared status range', () => {
    const site = policy('server', { dropServerStatus: [[400, 499]] })
    expect(decideReport(emptyReport, { statusCode: 422 }, site)).toEqual({ _tag: 'drop', rule: 'status' })
  })

  it('reports every status when the status rule is turned off', () => {
    const site = policy('server', { dropServerStatus: false })
    expect(decideReport(emptyReport, { statusCode: 404 }, site)).toEqual({ _tag: 'send' })
  })

  it('reports a transient failure when the transient rule is turned off', () => {
    const site = policy('server', { dropTransient: false })
    expect(decideReport(emptyReport, { name: 'AbortError' }, site)).toEqual({ _tag: 'send' })
  })

  it('keeps only the site rules when browser noise is turned off', () => {
    const site = policy('client', { browserNoise: false, ignoreErrors: ['zeroRuntime'] })
    expect(decideReport({ message: 'ResizeObserver loop' }, undefined, site)).toEqual({ _tag: 'send' })
    expect(decideReport({ message: 'zeroRuntime is off' }, undefined, site)).toEqual({ _tag: 'drop', rule: 'ignore-message' })
  })
})
