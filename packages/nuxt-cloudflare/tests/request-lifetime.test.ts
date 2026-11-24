import type { LocalFetch } from '../src/runtime/server/utils/request-lifetime'
import { describe, expect, it, vi } from 'vitest'
import requestLifetimePlugin from '../src/runtime/server/plugins/request-lifetime'
import { keepNativeRequestAlive, keepRequestAlive } from '../src/runtime/server/utils/request-lifetime'

vi.mock('nitropack/runtime', () => ({
  defineNitroPlugin: (setup: unknown) => setup,
  useRuntimeConfig: vi.fn(),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('keepRequestAlive', () => {
  it('keeps the Worker request alive until its own response settles', async () => {
    const pending = deferred<Response>()
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>()
    const localFetch = keepRequestAlive(() => pending.promise)

    const response = localFetch('/api/slow', { context: { waitUntil } })

    expect(waitUntil).toHaveBeenCalledTimes(1)
    let lifetimeSettled = false
    void waitUntil.mock.calls[0]![0].then(() => lifetimeSettled = true)
    await Promise.resolve()
    expect(lifetimeSettled).toBe(false)

    const body = new Response('fresh')
    pending.resolve(body)
    await expect(response).resolves.toBe(body)
    await waitUntil.mock.calls[0]![0]
    expect(lifetimeSettled).toBe(true)
  })

  it('gives a failed render to its caller and never rejects the lifetime promise', async () => {
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>()
    const failure = new Error('render failed')
    const localFetch = keepRequestAlive(() => Promise.reject(failure))

    await expect(localFetch('/broken', { context: { waitUntil } })).rejects.toBe(failure)
    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined()
  })

  it('leaves a fetch without a Worker context unchanged', async () => {
    const body = new Response('internal')
    const localFetch = keepRequestAlive(() => Promise.resolve(body))

    await expect(localFetch('/internal')).resolves.toBe(body)
    await expect(localFetch('/internal', { context: {} })).resolves.toBe(body)
  })
})

describe('keepNativeRequestAlive', () => {
  type WorkerRequest = Request & { waitUntil?: (promise: Promise<unknown>) => void }

  function workerRequest(url: string, kept: Promise<unknown>[]): WorkerRequest {
    return Object.assign(new Request(url), { waitUntil: (promise: Promise<unknown>) => void kept.push(promise) })
  }

  // `serverFetch` and `$fetch('/api/…')` dispatch a new Request with no `waitUntil`. A cached
  // handler in that sub-request registered nothing, so a caller that answered first stranded
  // the handler's shared resolution for every later request in the isolate.
  it('keeps the enclosing Worker request alive until a sub-request answers', async () => {
    const kept: Promise<unknown>[] = []
    const worker = workerRequest('https://example.test/api/stats.json', kept)
    const pending = deferred<Response>()
    const fetch = keepNativeRequestAlive(() => pending.promise, () => worker)

    void fetch(new Request('http://localhost/api/npm/nuxt/downloads'))
    let workerDone = false
    void Promise.all(kept).then(() => workerDone = true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(workerDone).toBe(false)

    pending.resolve(new Response('fresh'))
    await Promise.all(kept)
    expect(workerDone).toBe(true)
  })

  it('hands background work of a sub-request to the enclosing Worker request', async () => {
    const kept: Promise<unknown>[] = []
    const worker = workerRequest('https://example.test/api/stats.json', kept)
    const refresh = Promise.resolve('fresh')
    const fetch = keepNativeRequestAlive((request: WorkerRequest) => {
      request.waitUntil?.(refresh)
      return new Response('stale')
    }, () => worker)

    await fetch(new Request('http://localhost/api/github/nuxt@nuxt/stars'))

    expect(kept).toContain(refresh)
  })

  it('keeps the lifetime a request already has', async () => {
    const workerKept: Promise<unknown>[] = []
    const ownKept: Promise<unknown>[] = []
    const worker = workerRequest('https://example.test/api/stats.json', workerKept)
    const fetch = keepNativeRequestAlive(() => new Response('ok'), () => worker)

    await fetch(workerRequest('https://example.test/', ownKept))

    expect({ own: ownKept.length, worker: workerKept.length }).toEqual({ own: 1, worker: 0 })
  })
})

describe('request lifetime plugin', () => {
  // `nitropack/runtime` is mocked above, so the default export is the setup function itself.
  const setup = requestLifetimePlugin as unknown as (app: object) => void

  it('keeps the native Nitro 3 Worker request alive until its response finishes', async () => {
    const pending = deferred<Response>()
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>()
    const request = Object.assign(new Request('https://example.test/'), { waitUntil })
    const nitroApp = { fetch: vi.fn<(request: Request) => Promise<Response>>(() => pending.promise) }

    setup(nitroApp)
    const response = nitroApp.fetch(request)
    expect(waitUntil).toHaveBeenCalledTimes(1)
    const workerLifetime = waitUntil.mock.calls[0]![0]
    let settled = false
    void workerLifetime.then(() => settled = true)
    await Promise.resolve()
    expect(settled).toBe(false)

    const body = new Response('ok')
    pending.resolve(body)
    await expect(response).resolves.toBe(body)
    await expect(workerLifetime).resolves.toBeUndefined()
  })

  it('replaces localFetch on the Nitro app the Worker entry calls', async () => {
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>()
    const original = vi.fn<LocalFetch>(async () => new Response('ok'))
    const nitroApp: { hooks: object, localFetch: LocalFetch } = { hooks: { hook: vi.fn() }, localFetch: original }

    setup(nitroApp)
    await nitroApp.localFetch('/', { context: { waitUntil } })

    expect(nitroApp.localFetch).not.toBe(original)
    expect(original).toHaveBeenCalledTimes(1)
    expect(waitUntil).toHaveBeenCalledTimes(1)
  })

  it('keeps synchronous Nitro 3 responses synchronous outside Workers', () => {
    const body = new Response('internal')
    const nitroApp = { fetch: vi.fn<(request: Request) => Response>(() => body) }

    setup(nitroApp)

    expect(nitroApp.fetch(new Request('https://example.test/'))).toBe(body)
  })

  it('leaves an app without localFetch unchanged', () => {
    const nitroApp = { hooks: { hook: vi.fn() } }

    expect(() => setup(nitroApp)).not.toThrow()
    expect(nitroApp).not.toHaveProperty('localFetch')
  })
})
