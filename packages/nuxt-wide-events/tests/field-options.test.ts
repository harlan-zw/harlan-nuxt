import { describe, expect, it } from 'vitest'
import { resolveWideEventFields } from '../src/build/fields'

describe('resolveWideEventFields', () => {
  it('accepts unique dotted field names', () => {
    expect(resolveWideEventFields(['user.id', 'cart.itemCount'])).toEqual({
      _tag: 'Ok',
      fields: ['user.id', 'cart.itemCount'],
    })
  })

  it.each([
    ['duplicates', ['user.id', 'user.id'], 'DuplicateField'],
    ['reserved fields', ['status'], 'ReservedField'],
    ['invalid paths', ['User ID'], 'InvalidField'],
  ])('rejects %s', (_label, input, tag) => {
    expect(resolveWideEventFields(input)).toEqual({
      _tag: 'Err',
      issues: [expect.objectContaining({ _tag: tag })],
    })
  })
})
