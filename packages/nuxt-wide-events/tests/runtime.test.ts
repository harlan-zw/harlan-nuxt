import { describe, expect, it } from 'vitest'
import { addWideEventFields, captureWideEventError, emitWideEvent, startWideEvent } from '../src/runtime/server/index'

function event() {
  return {
    context: {} as Record<string, unknown>,
    method: 'POST',
    path: '/api/cart',
  }
}

const addCompilerOwnedFields = addWideEventFields as unknown as (
  request: ReturnType<typeof event>,
  fields: Record<string, unknown>,
  owned: true,
) => void

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

  it('keeps the first request identity when start runs twice', () => {
    const request = event()
    startWideEvent(request, 'req_first', 10)
    startWideEvent(request, 'req_second', 20)

    expect(emitWideEvent(request, 200, undefined, undefined, 12.5, 'now')).toEqual(expect.objectContaining({
      durationMs: 2.5,
      requestId: 'req_first',
    }))
  })

  it('combines Fields collected by separate server layers', () => {
    const request = event()
    startWideEvent(request, 'req_1', 10)
    addWideEventFields(request, { 'user.id': 'user_1' } as never)
    addWideEventFields(request, { 'cart.itemCount': 2 } as never)

    expect(emitWideEvent(request, 200, undefined, undefined, 12, 'now')).toEqual(expect.objectContaining({
      'cart.itemCount': 2,
      'user.id': 'user_1',
    }))
  })

  it('does not mutate Fields from an untransformed caller', () => {
    const request = event()
    const fields = { 'user.id': 'user_1' }
    startWideEvent(request, 'req_1', 10)
    addWideEventFields(request, fields as never)

    emitWideEvent(request, 200, 'shop', '/api/cart', 12, 'now')

    expect(fields).toEqual({ 'user.id': 'user_1' })
  })

  it('skips an undefined Field during migration', () => {
    const request = event()
    startWideEvent(request, 'req_1', 10)
    addWideEventFields(request, {
      'cart.itemCount': undefined,
      'user.id': 'user_1',
    } as never)

    const record = emitWideEvent(request, 200, undefined, undefined, 12, 'now')!

    expect(record['user.id']).toBe('user_1')
    expect(Object.hasOwn(record, 'cart.itemCount')).toBe(false)
  })

  it('leaves Fields untouched when a later value is invalid', () => {
    const request = event()
    const fields = {
      'cart.itemCount': undefined,
      'user.id': { secret: true },
    }
    startWideEvent(request, 'req_1', 10)

    expect(() => addWideEventFields(request, fields as never)).toThrow(/user.id/)
    expect(Object.hasOwn(fields, 'cart.itemCount')).toBe(true)
  })

  it('rejects prototype injection on the compiler-owned first literal', () => {
    const request = event()
    const fields = Object.assign(Object.create({ password: 'secret' }), { 'user.id': 'user_1' })
    startWideEvent(request, 'req_1', 10)

    expect(() => addCompilerOwnedFields(request, fields, true)).toThrow(/plain object literal/)
  })

  it('does not copy error strings into a production record', () => {
    const request = event()
    startWideEvent(request, 'req_1', 10)
    captureWideEventError(request, Object.assign(new Error('token sk_live_secret'), {
      name: 'SecretErrorName',
      statusCode: 401,
    }))

    const record = emitWideEvent(request, 401, undefined, undefined, 11, 'now')

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

    expect(emitWideEvent(request, 503, undefined, undefined, 12, 'now')).toEqual(expect.objectContaining({
      'level': 'error',
      'status': 503,
      'recovery.completed': true,
    }))
    expect(emitWideEvent(request, 200, undefined, undefined, 13, 'later')).toBeNull()
  })

  it('uses the response status when an earlier error was recovered', () => {
    const request = event()
    startWideEvent(request, 'req_1', 10)
    captureWideEventError(request, new Error('recovered'))

    expect(emitWideEvent(request, 200, undefined, undefined, 12, 'now')).toEqual(expect.objectContaining({
      level: 'error',
      status: 200,
    }))
  })

  it('ignores an error captured after emission', () => {
    const request = event()
    startWideEvent(request, 'req_1', 10)
    emitWideEvent(request, 200, undefined, undefined, 12, 'now')

    expect(() => captureWideEventError(request, new Error('late'))).not.toThrow()
  })

  it('does not copy a custom HTTP method into a production record', () => {
    const request = { ...event(), method: 'SECRET_METHOD_TOKEN' }
    startWideEvent(request, 'req_1', 10)

    const record = emitWideEvent(request, 200, undefined, undefined, 12, 'now')

    expect(record?.method).toBe('UNKNOWN')
    expect(JSON.stringify(record)).not.toContain('SECRET_METHOD_TOKEN')
  })

  it('rejects fields after emission', () => {
    const request = event()
    startWideEvent(request, 'req_1', 10)
    emitWideEvent(request, 200, undefined, undefined, 11, 'now')

    expect(() => addWideEventFields(request, { 'user.id': 'late' } as never)).toThrow(/already emitted/)
  })
})
