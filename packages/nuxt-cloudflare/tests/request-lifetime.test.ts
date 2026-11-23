import type { LocalFetch } from '../src/runtime/server/utils/request-lifetime'
import { describe, expect, it, vi } from 'vitest'
import requestLifetimePlugin from '../src/runtime/server/plugins/request-lifetime'
import { keepRequestAlive } from '../src/runtime/server/utils/request-lifetime'

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

describe('request lifetime plugin', () => {
  // `nitropack/runtime` is mocked above, so the default export is the setup function itself.
  const setup = requestLifetimePlugin as unknown as (app: object) => void

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

  it('leaves an app without localFetch unchanged', () => {
    const nitroApp = { hooks: { hook: vi.fn() } }

    expect(() => setup(nitroApp)).not.toThrow()
    expect(nitroApp).not.toHaveProperty('localFetch')
  })
})
