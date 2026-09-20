import type { Fetcher } from '../src/runtime/core/client'
import type { ScoreCriteria, SystemOneResult } from '../src/runtime/core/questions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createJevHttpClient } from '../src/runtime/core/client'
import { choice, noul, score } from '../src/runtime/core/questions'

function jevResponse(answers: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    success: true,
    result: { state: null, result: { model: 'typesafe/jev', answers, usage: { input_tokens: 10, output_tokens: 5 } } },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

const okFetcher = vi.fn(async () => jevResponse({ q: { type: 'noul', noul: 0.91 } }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('createJevHttpClient', () => {
  it('unwraps the double envelope into a typed result', async () => {
    const client = createJevHttpClient({ apiToken: 't', accountId: 'a', fetcher: okFetcher })
    const result = await client.systemOne({ state: { q: 'x' }, questions: { q: noul('Is it brand?') } })
    expect(result).toMatchObject({
      _tag: 'Ok',
      result: {
        model: 'typesafe/jev',
        answers: { q: { type: 'noul', noul: 0.91 } },
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })
  })

  it('treats a 2xx body without answers as a failure', async () => {
    const inner: Partial<SystemOneResult> = { model: 'typesafe/jev', usage: { input_tokens: 1, output_tokens: 1 } }
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: true, result: { state: null, result: inner } }), { status: 200 }))
    const client = createJevHttpClient({ apiToken: 't', accountId: 'a', fetcher })
    const result = await client.systemOne({ state: null, questions: { q: noul() } })
    expect(result).toMatchObject({ _tag: 'Err', failure: { _tag: 'Invalid' } })
  })

  it('treats a failed cf envelope as a failure', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'nope' }] }), { status: 200 }))
    const client = createJevHttpClient({ apiToken: 't', accountId: 'a', fetcher })
    const result = await client.systemOne({ state: null, questions: { q: noul() } })
    expect(result).toMatchObject({ _tag: 'Err', failure: { _tag: 'Invalid', message: expect.stringContaining('cf envelope failed') } })
  })

  it('returns an Http failure with details and does not retry a 401', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'bad token' }] }), { status: 401, headers: { 'cf-ray': 'ray-1' } }))
    const client = createJevHttpClient({ apiToken: 't', accountId: 'a', retries: 2, fetcher })
    const result = await client.systemOne({ state: null, questions: { q: noul() } })
    expect(result._tag).toBe('Err')
    if (result._tag === 'Err' && result.failure._tag === 'Http') {
      expect(result.failure.status).toBe(401)
      expect(result.failure.requestId).toBe('ray-1')
      expect(result.failure.details).toMatchObject({ success: false })
    }
    else {
      expect.unreachable('expected an Http failure')
    }
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('honours retry-after and retries a 429', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(jevResponse({ q: { type: 'noul', noul: 0.8 } }))
    const client = createJevHttpClient({ apiToken: 't', accountId: 'a', retries: 2, fetcher })
    const pending = client.systemOne({ state: null, questions: { q: noul() } })
    const result = await vi.advanceTimersByTimeAsync(1000).then(() => pending)
    expect(result).toMatchObject({ _tag: 'Ok' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('returns an Http failure when 429 retries run out', async () => {
    const fetcher = vi.fn(async () => new Response('rate limited', { status: 429 }))
    const client = createJevHttpClient({ apiToken: 't', accountId: 'a', retries: 1, fetcher })
    const result = await client.systemOne({ state: null, questions: { q: noul() } })
    expect(result).toMatchObject({ _tag: 'Err', failure: { _tag: 'Http', status: 429 } })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('aborts a hanging request within the window', async () => {
    const hanging: Fetcher = (_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal
      if (signal)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    const client = createJevHttpClient({ apiToken: 't', accountId: 'a', timeoutMs: 40, fetcher: hanging })
    const startedAt = Date.now()
    const result = await client.systemOne({ state: null, questions: { q: noul() } })
    expect(result).toMatchObject({ _tag: 'Err', failure: { _tag: 'Timeout' } })
    expect(Date.now() - startedAt).toBeLessThan(5000)
  })

  it('returns a Network failure when the fetch rejects', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('connection reset')
    })
    const client = createJevHttpClient({ apiToken: 't', accountId: 'a', fetcher })
    const result = await client.systemOne({ state: null, questions: { q: noul() } })
    expect(result).toMatchObject({ _tag: 'Err', failure: { _tag: 'Network', message: 'connection reset' } })
  })

  it('sends cf-aig-cache-ttl only when cacheTtl is positive', async () => {
    const fetcher = vi.fn<Fetcher>(async () => jevResponse({ q: { type: 'noul', noul: 0.5 } }))
    const without = createJevHttpClient({ apiToken: 't', accountId: 'a', fetcher })
    await without.systemOne({ state: null, questions: { q: noul() } })
    expect((fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>)['cf-aig-cache-ttl']).toBeUndefined()

    const withTtl = createJevHttpClient({ apiToken: 't', accountId: 'a', cacheTtl: 90, fetcher })
    await withTtl.systemOne({ state: null, questions: { q: noul() } })
    expect((fetcher.mock.calls[1]?.[1]?.headers as Record<string, string>)['cf-aig-cache-ttl']).toBe('90')
  })

  it('sends the gateway header only when a gateway is set', async () => {
    const fetcher = vi.fn<Fetcher>(async () => jevResponse({ q: { type: 'noul', noul: 0.5 } }))
    const without = createJevHttpClient({ apiToken: 't', accountId: 'a', fetcher })
    await without.systemOne({ state: null, questions: { q: noul() } })
    expect((fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>)['cf-aig-gateway-id']).toBeUndefined()

    const withGateway = createJevHttpClient({ apiToken: 't', accountId: 'a', gatewayId: 'gw-1', fetcher })
    await withGateway.systemOne({ state: null, questions: { q: noul() } })
    expect((fetcher.mock.calls[1]?.[1]?.headers as Record<string, string>)['cf-aig-gateway-id']).toBe('gw-1')
  })

  it('rejects invalid question sets before sending', async () => {
    const fetcher = vi.fn(async () => jevResponse({ q: { type: 'noul', noul: 0.5 } }))
    const client = createJevHttpClient({ apiToken: 't', accountId: 'a', fetcher })
    const empty = await client.systemOne({ state: null, questions: {} })
    expect(empty).toMatchObject({ _tag: 'Err', failure: { _tag: 'Invalid', message: 'At least one question is required.' } })
    const oneLevel = await client.systemOne({ state: null, questions: { q: score('Rate it', ['low'] as unknown as ScoreCriteria) } })
    expect(oneLevel).toMatchObject({ _tag: 'Err', failure: { _tag: 'Invalid', message: expect.stringContaining('2 to 10 levels') } })
    const oneOption = await client.systemOne({ state: null, questions: { q: choice('Pick one', { only: 'one' }) } })
    expect(oneOption).toMatchObject({ _tag: 'Err', failure: { _tag: 'Invalid', message: expect.stringContaining('2 to 255 options') } })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects answers that fail validation', async () => {
    const fetcher = vi.fn(async () => jevResponse({ q: { type: 'choice', choice: 'nope', confidence: 0.9, probabilities: {} } }))
    const client = createJevHttpClient({ apiToken: 't', accountId: 'a', fetcher })
    const result = await client.systemOne({ state: null, questions: { q: choice('Pick one', { yes: 'y', no: 'n' }) } })
    expect(result).toMatchObject({ _tag: 'Err', failure: { _tag: 'Invalid', message: expect.stringContaining('does not name one of its criteria') } })
  })
})
