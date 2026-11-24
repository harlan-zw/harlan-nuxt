// @vitest-environment node

import type { ServerRequest } from 'nitro/types'
import type { NativeFetch, RuntimeApp } from '../src/runtime/server/nitro-types'
import { H3 } from 'nitro/h3'
import { expect, it, vi } from 'vitest'
import installFetchTelemetry from '../src/runtime/server/plugins/fetch-telemetry'

vi.mock('#nuxt-use-query/nitro', () => ({
  defineNitroPlugin: (setup: (app: RuntimeApp) => void) => setup,
  useEvent: () => ({ context: {}, method: 'GET', path: '/outer' }),
  useRuntimeConfig: () => ({ nuxtUseQuery: { telemetry: { console: false } } }),
}))

it('keeps client IP and background work on an instrumented native request', async () => {
  const backgroundWork = Promise.resolve('written')
  const scheduled: Promise<unknown>[] = []
  const input = new Request('https://fixture.example/inner') as ServerRequest
  input.ip = '192.0.2.42'
  input.waitUntil = function (promise) {
    expect(this).toBe(input)
    scheduled.push(promise)
  }

  const app = new H3()
  app.get('/inner', (event) => {
    event.waitUntil(backgroundWork)
    return { ip: event.req.ip }
  })
  let fetchRequest: NativeFetch = async request => app.fetch(request)
  const runtime: RuntimeApp = {
    _tag: 'Nitro3',
    fetch: fetchRequest,
    setFetch(fetch) {
      fetchRequest = fetch
    },
    hooks: {
      hook: () => {},
      callHook: async () => {},
    },
  }
  vi.stubGlobal('fetch', globalThis.fetch)

  try {
    installFetchTelemetry(runtime)

    const response = await fetchRequest(input)
    expect({
      payload: await response.json(),
      background: await Promise.all(scheduled),
    }).toEqual({
      payload: { ip: '192.0.2.42' },
      background: ['written'],
    })
  }
  finally {
    vi.unstubAllGlobals()
  }
})
