import type { NitroAppPlugin } from 'nitro/types'
import type { PlatformProxy } from 'wrangler'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCloudflareBindings, setCloudflareBindings } from '../src/bindings'
import { createDevProxy } from '../src/runtime/server/plugins/dev-proxy'

vi.mock('node:module', async original => ({
  ...await original<typeof import('node:module')>(),
  createRequire: vi.fn(),
}))
vi.mock('@harlan-zw/nuxt-cloudflare/bindings', () => import('../src/bindings'))

const options = { rootDir: import.meta.dirname, persist: false as const }

afterEach(() => {
  setCloudflareBindings(undefined)
  vi.restoreAllMocks()
})

function appWithRequest() {
  let requestHook = (_event: { context: Record<string, unknown>, req: Request }) => {}
  let close = async () => {}
  const app = {
    hooks: {
      hook(name: string, handler: typeof requestHook & (() => Promise<void>)) {
        if (name === 'request')
          requestHook = handler
        if (name === 'close')
          close = handler
      },
    },
  } as unknown as Parameters<NitroAppPlugin>[0]
  return {
    app,
    close: () => close(),
    fetch: async () => {
      const event = { context: {}, req: new Request('http://localhost/') }
      requestHook(event)
      return createCloudflareBindings<{ DB: { query: () => number } }>().require('DB', event).query()
    },
  }
}

describe('node proxy startup', () => {
  it('holds the first request and startup consumers until DB is ready', async () => {
    let ready!: (proxy: PlatformProxy) => void
    const pending = new Promise<PlatformProxy>(resolve => ready = resolve)
    vi.mocked(createRequire).mockReturnValue((() => ({ getPlatformProxy: () => pending })) as never)
    const server = appWithRequest()
    let started = false
    const startup = (async () => {
      const plugin = await createDevProxy(options)
      // Nitro calls plugins synchronously and discards their return values.
      plugin(server.app)
      const db = createCloudflareBindings<{ DB: { query: () => number } }>().require('DB')
      started = true
      return db.query()
    })()
    // Observe rejection immediately while holding initialization pending.
    const startupResult = expect(startup).resolves.toBe(42)
    await Promise.resolve()
    expect(started).toBe(false)
    const dispose = vi.fn(async () => {})
    ready({ env: { DB: { query: () => 42 } }, cf: {}, ctx: { waitUntil() {} }, dispose } as unknown as PlatformProxy)
    await startupResult
    await expect(server.fetch()).resolves.toBe(42)
    await server.close()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('reports the original initialization error during startup', async () => {
    const failure = new Error('missing explicit Wrangler config')
    vi.mocked(createRequire).mockReturnValue((() => ({ getPlatformProxy: async () => {
      throw failure
    } })) as never)
    await expect(Promise.resolve().then(() => createDevProxy(options))).rejects.toBe(failure)
  })
})
