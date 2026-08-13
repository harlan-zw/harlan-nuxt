import { describe, expect, it } from 'vitest'
import { createWideEventValidationPlugin } from '../src/build/source-scan'
import { validateWideEventSource } from '../src/build/source-validation'

const fields = new Set(['cart.itemCount', 'user.id'])

describe('validateWideEventSource', () => {
  it('accepts configured literal fields', () => {
    const result = validateWideEventSource(`
      export default defineEventHandler((event) => {
        addWideEventFields(event, {
          'user.id': '123',
          'cart.itemCount': 2,
        })
      })
    `, 'server/api/cart.ts', fields)

    expect(result).toEqual({ _tag: 'Ok' })
  })

  it('rejects a field that was not configured', () => {
    const result = validateWideEventSource(`addWideEventFields(event, { password: input.password })`, 'server/api/user.ts', fields)

    expect(result).toEqual({
      _tag: 'Err',
      issues: [expect.objectContaining({
        _tag: 'UnknownField',
        field: 'password',
        file: 'server/api/user.ts',
      })],
    })
  })

  it.each([
    ['a variable', 'addWideEventFields(event, fields)', 'DynamicFields'],
    ['a spread', 'addWideEventFields(event, { ...fields })', 'SpreadFields'],
    ['a computed field', 'addWideEventFields(event, { [field]: value })', 'ComputedField'],
  ])('rejects %s because the build cannot prove it safe', (_label, source, tag) => {
    const result = validateWideEventSource(source, 'server/api/unsafe.ts', fields)

    expect(result).toEqual({
      _tag: 'Err',
      issues: [expect.objectContaining({ _tag: tag })],
    })
  })

  it('validates an aliased package import', () => {
    const result = validateWideEventSource(`
      import { addWideEventFields as addFields } from '@harlan-zw/nuxt-wide-events/server'
      addFields(event, { token: input.token })
    `, 'server/api/user.ts', fields)

    expect(result).toEqual({
      _tag: 'Err',
      issues: [expect.objectContaining({ _tag: 'UnknownField', field: 'token' })],
    })
  })

  it('ignores a local function with the same name', () => {
    const result = validateWideEventSource(`
      const addWideEventFields = (_event, value) => value
      addWideEventFields(event, { password: input.password })
    `, 'server/api/local.ts', fields)

    expect(result).toEqual({ _tag: 'Ok' })
  })

  it('resolves auto-import calls within their lexical scope', () => {
    const result = validateWideEventSource(`
      addWideEventFields(event, { password: input.password })
      function localScope(addWideEventFields) {
        addWideEventFields(event, { token: input.token })
      }
    `, 'server/api/scoped.ts', fields)

    expect(result).toEqual({
      _tag: 'Err',
      issues: [expect.objectContaining({ _tag: 'UnknownField', field: 'password' })],
    })
  })

  it('resolves imported aliases within their lexical scope', () => {
    const result = validateWideEventSource(`
      import { addWideEventFields as addFields } from '@harlan-zw/nuxt-wide-events/server'
      addFields(event, { password: input.password })
      function localScope(addFields) {
        addFields(event, { token: input.token })
      }
    `, 'server/api/scoped-import.ts', fields)

    expect(result).toEqual({
      _tag: 'Err',
      issues: [expect.objectContaining({ _tag: 'UnknownField', field: 'password' })],
    })
  })

  it('validates an alias imported from Nuxt server imports', () => {
    const result = validateWideEventSource(`
      import { addWideEventFields as addFields } from '#imports'
      addFields(event, { password: input.password })
    `, 'server/api/nuxt-import.ts', fields)

    expect(result).toEqual({
      _tag: 'Err',
      issues: [expect.objectContaining({ _tag: 'UnknownField', field: 'password' })],
    })
  })
})

describe('createWideEventValidationPlugin', () => {
  it('validates transformed modules outside the Nuxt root without changing code', () => {
    const plugin = createWideEventValidationPlugin('/app', fields)
    const valid = runTransform(plugin, `addWideEventFields(event, { 'user.id': '123' })`, '/workspace/shared/event.ts')

    expect(valid).toBeNull()
    expect(() => runTransform(
      plugin,
      'addWideEventFields(event, { password: input.password })',
      '/workspace/shared/event.ts',
    )).toThrow('../workspace/shared/event.ts:1 Field "password" is not configured')
  })

  it('validates source ids with bundler queries', () => {
    const plugin = createWideEventValidationPlugin('/app', fields)

    expect(() => runTransform(
      plugin,
      'addWideEventFields(event, { password: input.password })',
      '/app/backend/api/record.ts?macro=true',
    )).toThrow('backend/api/record.ts:1 Field "password" is not configured')
  })
})

interface TransformPlugin {
  transform?: unknown
}

function runTransform(plugin: TransformPlugin, code: string, id: string): unknown {
  if (typeof plugin.transform !== 'function')
    throw new TypeError('Expected a transform function.')
  return plugin.transform.call({}, code, id)
}
