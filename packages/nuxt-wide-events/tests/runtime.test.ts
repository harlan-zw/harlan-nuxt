import { describe, expect, it } from 'vitest'
import { addWideEventFields, captureWideEventError, emitWideEvent, startWideEvent } from '../src/runtime/server/index'

function event() {
  return {
    context: {} as Record<string, unknown>,
    method: 'POST',
    path: '/api/cart',
  }
}

describe('wide Event runtime', () => {
  it('emits one structured record with configured fields', () => {
    const request = event()
    startWideEvent(request, 'req_1', 10)
    addWideEventFields(request, {
      'user.id': 'user_1',
      'cart.itemCount': 2,
    } as never)

    expect(emitWideEvent(request, 201, 'shop', '/api/cart', 12.5, '2026-08-13T00:00:00.000Z')).toEqual({
      'timestamp': '2026-08-13T00:00:00.000Z',
      'level': 'info',
      'service': 'shop',
      'method': 'POST',
      'path': '/api/cart',
      'status': 201,
      'durationMs': 2.5,
      'requestId': 'req_1',
      'user.id': 'user_1',
      'cart.itemCount': 2,
    })
  })

  it('uses the route template instead of a path that can contain secrets', () => {
    const request = {
      ...event(),
      context: {
        matchedRoute: { path: '/reset/:token' },
      },
      path: '/reset/sk_live_secret?token=another_secret',
    }
    startWideEvent(request, 'req_1', 10)

    const record = emitWideEvent(request, 200, undefined, request.context.matchedRoute.path, 11, 'now')

    expect(record?.path).toBe('/reset/:token')
    expect(JSON.stringify(record)).not.toContain('sk_live_secret')
    expect(JSON.stringify(record)).not.toContain('another_secret')
  })

  it('emits only once', () => {
    const request = event()
    startWideEvent(request, 'req_1', 10)

    expect(emitWideEvent(request, 200, undefined, undefined, 11, 'now')).not.toBeNull()
    expect(emitWideEvent(request, 200, undefined, undefined, 12, 'later')).toBeNull()
  })

  it('does not copy error strings into a production record', () => {
    const request = event()
    startWideEvent(request, 'req_1', 10)
    captureWideEventError(request, Object.assign(new Error('token sk_live_secret'), {
      name: 'SecretErrorName',
      statusCode: 401,
    }))

    const record = emitWideEvent(request, 200, undefined, undefined, 11, 'now')

    expect(record).toEqual(expect.objectContaining({
      level: 'error',
      status: 401,
    }))
    expect(JSON.stringify(record)).not.toContain('sk_live_secret')
    expect(JSON.stringify(record)).not.toContain('SecretErrorName')
  })

  it('collects fields after a captured error and emits once after the response', () => {
    const request = event()
    startWideEvent(request, 'req_1', 10)
    captureWideEventError(request, Object.assign(new Error('secret'), { statusCode: 503 }))
    addWideEventFields(request, { 'recovery.completed': true } as never)

    expect(emitWideEvent(request, 200, undefined, undefined, 12, 'now')).toEqual(expect.objectContaining({
      'level': 'error',
      'status': 503,
      'recovery.completed': true,
    }))
    expect(emitWideEvent(request, 200, undefined, undefined, 13, 'later')).toBeNull()
  })

  it('rejects fields after emission', () => {
    const request = event()
    startWideEvent(request, 'req_1', 10)
    emitWideEvent(request, 200, undefined, undefined, 11, 'now')

    expect(() => addWideEventFields(request, { 'user.id': 'late' } as never)).toThrow(/already emitted/)
  })
})
