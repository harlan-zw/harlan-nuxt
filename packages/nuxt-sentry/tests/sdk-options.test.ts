import type { DataCollection } from '../src/runtime/shared/types'
import {
  captureMessage,
  CloudflareClient,
  consoleLoggingIntegration,
  createTransport,
  logger,
  SDK_VERSION,
  setCurrentClient,
} from '@sentry/cloudflare'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSentryInitOptions } from '../src/runtime/shared/policy'

// These tests start a real client from whichever `@sentry/cloudflare` is
// installed, so the same file proves the options on Sentry 10 and Sentry 11.

function startClient(options: Record<string, unknown>) {
  const envelopes: string[] = []
  const client = new CloudflareClient({
    dsn: 'https://public@sentry.invalid/1',
    integrations: [],
    // One frame per stack, so a synthetic stack would show in the envelope.
    stackParser: () => [{ filename: 'app:///app.js', function: 'handler', lineno: 1, in_app: true }],
    transport: transportOptions => createTransport(transportOptions, async (request) => {
      envelopes.push(typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body))
      return {}
    }),
    ...options,
  } as ConstructorParameters<typeof CloudflareClient>[0])
  setCurrentClient(client)
  client.init()
  return { client, envelopes }
}

function initOptions(dataCollection: DataCollection, logs = false) {
  return createSentryInitOptions({ sdkVersion: SDK_VERSION, dataCollection, logs })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe(`createSentryInitOptions on @sentry/cloudflare ${SDK_VERSION}`, () => {
  it('collects no personal data under dataCollection none', () => {
    const { client } = startClient(initOptions('none'))
    const resolved = client.getDataCollectionOptions() as ReturnType<typeof client.getDataCollectionOptions> & { queues?: boolean }

    expect(resolved).toMatchObject({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
    })
    // Sentry 11 added queue message payloads and collects them by default.
    expect(resolved.queues ?? false).toBe(false)
  })

  it('collects the full request under dataCollection scrubbed, for the Redaction Rules to clean', () => {
    const { client } = startClient(initOptions('scrubbed'))

    expect(client.getDataCollectionOptions()).toMatchObject({
      userInfo: true,
      cookies: true,
      httpHeaders: { request: true, response: true },
      httpBodies: ['incomingRequest', 'outgoingRequest', 'incomingResponse', 'outgoingResponse'],
      urlQueryParams: true,
      databaseQueryData: true,
    })
  })

  it('sends a message report with no synthetic stack, so stackless Drop Rules keep deciding', async () => {
    const { client, envelopes } = startClient(initOptions('none'))

    captureMessage('plain message')
    await client.flush(1000)

    expect(envelopes).toHaveLength(1)
    expect(envelopes[0]).toContain('plain message')
    expect(envelopes[0]).not.toContain('"stacktrace"')
  })

  it('sends Sentry logs when logs are on', async () => {
    // Silence the console before the integration wraps it, or the spy replaces the wrapper.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client, envelopes } = startClient({
      ...initOptions('none', true),
      integrations: [consoleLoggingIntegration({ levels: ['warn', 'error'] })],
    })

    logger.warn('logger warning')
    console.warn('console warning')
    await client.flush(1000)

    const sent = envelopes.join('\n')
    expect(sent).toContain('logger warning')
    expect(sent).toContain('console warning')
  })
})
