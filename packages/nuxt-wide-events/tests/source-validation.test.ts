import { describe, expect, it } from 'vitest'
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
})
