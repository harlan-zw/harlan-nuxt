import { describe, expect, it, vi } from 'vitest'
import { defineNitroPlugin } from '../src/runtime/server/nitro2'
import { getHeader, getResponseHeader, setResponseHeader } from '../src/runtime/server/plugins/headers'

vi.mock('nitropack/runtime', () => ({
  defineNitroPlugin: (setup: unknown) => setup,
  useRuntimeConfig: vi.fn(),
}))

describe('nitro 2 native responses', () => {
  it('clamps the body headers that h3 copies after beforeResponse', async () => {
    const hooks = new Map<string, (...args: any[]) => unknown>()
    const plugin = defineNitroPlugin((app) => {
      app.hooks.hook('beforeResponse', (event) => {
        expect(getHeader(event, 'authorization')).toBe('Bearer fixture')
        expect(getResponseHeader(event, 'content-type')).toBe('text/html')
        expect(getResponseHeader(event, 'cache-control')).toBe('public, s-maxage=3600')
        setResponseHeader(event, 'cache-control', 'public, s-maxage=600')
      })
    })
    plugin({ hooks: { hook: (name: string, handler: (...args: any[]) => unknown) => hooks.set(name, handler) } } as never)
    const response = new Response('<html>cached</html>', { headers: { 'content-type': 'text/html' } })
    const setHeader = vi.fn()
    const event = {
      path: '/cached',
      node: {
        req: { headers: { authorization: 'Bearer fixture' } },
        res: { statusCode: 200, getHeader: (name: string) => name === 'cache-control' ? 'public, s-maxage=3600' : undefined, setHeader },
      },
    }
    await hooks.get('beforeResponse')!(event, { body: response })
    expect(response.headers.get('cache-control')).toBe('public, s-maxage=600')
    expect(setHeader).toHaveBeenCalledWith('cache-control', 'public, s-maxage=600')
  })
})
