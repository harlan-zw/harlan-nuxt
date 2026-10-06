import { describe, expect, it, vi } from 'vitest'
import { getHeader, getResponseHeader, getResponseStatus, setResponseHeader } from '../src/runtime/server/plugins/headers'

describe('response headers across Nitro builders', () => {
  it('uses the final portable response even when a Node bridge exists', () => {
    const setHeader = vi.fn()
    const event = {
      path: '/cached',
      req: new Request('https://example.test/cached', { headers: { authorization: 'Bearer test' } }),
      res: { status: 201, headers: new Headers({ 'cache-control': 'public, s-maxage=3600' }) },
      node: { req: { headers: {} }, res: { statusCode: 200, getHeader: () => undefined, setHeader } },
    }
    expect(getHeader(event, 'authorization')).toBe('Bearer test')
    expect(getResponseHeader(event, 'cache-control')).toBe('public, s-maxage=3600')
    expect(getResponseStatus(event)).toBe(201)
    setResponseHeader(event, 'cache-control', 'public, s-maxage=600')
    expect(event.res.headers.get('cache-control')).toBe('public, s-maxage=600')
    expect(setHeader).not.toHaveBeenCalled()
  })
})
