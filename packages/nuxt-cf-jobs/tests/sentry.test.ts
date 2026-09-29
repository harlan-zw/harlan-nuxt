import type { CloudflareOptions } from '@sentry/cloudflare'
import { createTransport, SDK_VERSION } from '@sentry/cloudflare'
import { describe, expect, it, vi } from 'vitest'
import { runWithQueueSentry } from '../src/runtime/server/sentry'

// No mock: this drives the installed `@sentry/cloudflare`, so it proves the
// adapter against whichever Sentry major the lockfile resolves.

// Sentry 11 caches the first client per isolate, with its transport, so every
// test reads one shared envelope list.
const envelopes: string[] = []

function queueOptions() {
  const options: CloudflareOptions = {
    dsn: 'https://public@sentry.invalid/1',
    transport: transportOptions => createTransport(transportOptions, async (request) => {
      envelopes.push(typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body))
      return {}
    }),
  }
  return options
}

function executionContext() {
  const pending: Promise<unknown>[] = []
  const context = {
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      pending.push(promise)
    }),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext
  return { context, settled: () => Promise.all(pending) }
}

describe(`runWithQueueSentry on @sentry/cloudflare ${SDK_VERSION}`, () => {
  it('returns the queue handler result', async () => {
    const options = queueOptions()
    const { context } = executionContext()

    await expect(runWithQueueSentry({ queue: 'events', context, options }, async () => 'processed'))
      .resolves
      .toBe('processed')
  })

  it('rethrows a queue handler failure and reports it to Sentry', async () => {
    const options = queueOptions()
    const { context, settled } = executionContext()
    const failure = new Error('queue failed')

    await expect(runWithQueueSentry({ queue: 'events', context, options }, async () => Promise.reject(failure)))
      .rejects
      .toBe(failure)
    await settled()

    const sent = envelopes.join('\n')
    expect(sent).toContain('queue failed')
    expect(sent).toContain('https://queue.internal/events')
  })
})
