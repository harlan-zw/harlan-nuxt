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
    ['a getter', 'addWideEventFields(event, { get "user.id"() { return input.userId } })', 'NonDataField'],
    ['a method', 'addWideEventFields(event, { "user.id"() { return input.userId } })', 'NonDataField'],
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

  it('validates API calls in default parameter initializers', () => {
    const result = validateWideEventSource(`
      function read(input = addWideEventFields(event, { password: secret })) {
        return input
      }
    `, 'server/api/default.ts', fields)

    expect(result).toEqual({
      _tag: 'Err',
      issues: [expect.objectContaining({ _tag: 'UnknownField', field: 'password' })],
    })
  })

  it.each([
    [
      'a copied alias',
      `
        import { addWideEventFields } from '@harlan-zw/nuxt-wide-events/server'
        const addFields = addWideEventFields
        addFields(event, { password: secret })
      `,
    ],
    [
      'a sequence callee',
      `
        import { addWideEventFields } from '@harlan-zw/nuxt-wide-events/server'
        ;(0, addWideEventFields)(event, { password: secret })
      `,
    ],
    [
      'Function.call',
      `
        import { addWideEventFields } from '@harlan-zw/nuxt-wide-events/server'
        addWideEventFields.call(undefined, event, { password: secret })
      `,
    ],
    [
      'a server namespace member',
      `
        import * as wideEvents from '@harlan-zw/nuxt-wide-events/server'
        wideEvents.addWideEventFields(event, { password: secret })
      `,
    ],
    [
      'a standalone namespace member',
      `
        import * as wideEvents from '@harlan-zw/nuxt-wide-events/standalone'
        wideEvents.createWideEvent({ password: secret })
      `,
    ],
  ])('rejects %s because API references must be direct calls', (_label, source) => {
    const result = validateWideEventSource(source, 'server/api/indirect.ts', fields)

    expect(result).toEqual({
      _tag: 'Err',
      issues: expect.arrayContaining([expect.objectContaining({ _tag: 'InvalidApiReference' })]),
    })
  })

  it.each([
    `export { addWideEventFields } from '@harlan-zw/nuxt-wide-events/server'`,
    `export * from '@harlan-zw/nuxt-wide-events/server'`,
    `const wideEvents = await import('@harlan-zw/nuxt-wide-events/standalone')`,
  ])('rejects an indirect API export or import', (source) => {
    const result = validateWideEventSource(source, 'server/api/indirect-module.ts', fields)

    expect(result).toEqual({
      _tag: 'Err',
      issues: [expect.objectContaining({ _tag: 'InvalidApiReference' })],
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

  it('validates configured initial standalone Fields', () => {
    const result = validateWideEventSource(`
      import { createWideEvent } from '@harlan-zw/nuxt-wide-events/standalone'
      createWideEvent({ 'user.id': '123' })
      createWideEvent()
    `, 'server/jobs/sync.ts', fields)

    expect(result).toEqual({ _tag: 'Ok' })
  })

  it.each([
    ['an unknown Field', `createWideEvent({ token: input.token })`, 'UnknownField'],
    ['a variable', `createWideEvent(fields)`, 'DynamicFields'],
    ['a spread', `createWideEvent({ ...fields })`, 'SpreadFields'],
    ['a computed Field', `createWideEvent({ [field]: value })`, 'ComputedField'],
  ])('rejects standalone initial Fields containing %s', (_label, source, tag) => {
    const result = validateWideEventSource(source, 'server/jobs/unsafe.ts', fields)

    expect(result).toEqual({
      _tag: 'Err',
      issues: [expect.objectContaining({ _tag: tag })],
    })
  })

  it('validates an aliased standalone import within its lexical scope', () => {
    const result = validateWideEventSource(`
      import { createWideEvent as createEvent } from '@harlan-zw/nuxt-wide-events/standalone'
      createEvent({ password: input.password })
      function localScope(createEvent) {
        createEvent({ token: input.token })
      }
    `, 'server/jobs/scoped.ts', fields)

    expect(result).toEqual({
      _tag: 'Err',
      issues: [expect.objectContaining({ _tag: 'UnknownField', field: 'password' })],
    })
  })

  it('validates a standalone package import', () => {
    const result = validateWideEventSource(`
      import { createWideEvent as createEvent } from '@harlan-zw/nuxt-wide-events/standalone'
      createEvent({ password: input.password })
    `, 'server/jobs/import.ts', fields)

    expect(result).toEqual({
      _tag: 'Err',
      issues: [expect.objectContaining({ _tag: 'UnknownField', field: 'password' })],
    })
  })

  it('ignores a local standalone factory with the same name', () => {
    const result = validateWideEventSource(`
      const createWideEvent = value => value
      createWideEvent({ password: input.password })
    `, 'server/jobs/local.ts', fields)

    expect(result).toEqual({ _tag: 'Ok' })
  })
})

describe('createWideEventValidationPlugin', () => {
  it('marks validated inline Fields as compiler-owned', () => {
    const plugin = createWideEventValidationPlugin('/app', fields)
    const valid = runTransform(plugin, `addWideEventFields(event, { 'user.id': '123' })`, '/workspace/shared/event.ts')

    expect(valid).toEqual({
      code: `addWideEventFields(event, { 'user.id': '123' }, true)`,
      map: null,
    })
    expect(() => runTransform(
      plugin,
      'addWideEventFields(event, { password: input.password })',
      '/workspace/shared/event.ts',
    )).toThrow('../workspace/shared/event.ts:1 Field "password" is not configured')
  })

  it('marks validated imported aliases as compiler-owned', () => {
    const plugin = createWideEventValidationPlugin('/app', fields)
    const source = `import { addWideEventFields as addFields } from '@harlan-zw/nuxt-wide-events/server'\naddFields(event, { 'user.id': '123' })`

    expect(runTransform(plugin, source, '/app/server/api/user.ts')).toEqual({
      code: `import { addWideEventFields as addFields } from '@harlan-zw/nuxt-wide-events/server'\naddFields(event, { 'user.id': '123' }, true)`,
      map: null,
    })
  })

  it('preserves a trailing comma while marking Fields as compiler-owned', () => {
    const plugin = createWideEventValidationPlugin('/app', fields)

    expect(runTransform(
      plugin,
      `addWideEventFields(event, { 'user.id': '123' },)`,
      '/app/server/api/user.ts',
    )).toEqual({
      code: `addWideEventFields(event, { 'user.id': '123' }, true,)`,
      map: null,
    })
  })

  it('does not mark compiler-owned Fields twice', () => {
    const plugin = createWideEventValidationPlugin('/app', fields)

    expect(runTransform(
      plugin,
      `addWideEventFields(event, { 'user.id': '123' }, true)`,
      '/app/server/api/user.ts',
    )).toBeNull()
  })

  it('preserves Unicode before a compiler-owned Field literal', () => {
    const plugin = createWideEventValidationPlugin('/app', fields)
    const source = `const label = '🦄'\naddWideEventFields(event, { 'user.id': label })`

    expect(runTransform(plugin, source, '/app/server/api/user.ts')).toEqual({
      code: `const label = '🦄'\naddWideEventFields(event, { 'user.id': label }, true)`,
      map: null,
    })
  })

  it('validates source ids with bundler queries', () => {
    const plugin = createWideEventValidationPlugin('/app', fields)

    expect(() => runTransform(
      plugin,
      'addWideEventFields(event, { password: input.password })',
      '/app/backend/api/record.ts?macro=true',
    )).toThrow('backend/api/record.ts:1 Field "password" is not configured')
  })

  it('validates standalone initial Fields in transformed modules', () => {
    const plugin = createWideEventValidationPlugin('/app', fields)

    expect(() => runTransform(
      plugin,
      'createWideEvent({ password: input.password })',
      '/app/server/jobs/sync.ts',
    )).toThrow('server/jobs/sync.ts:1 Field "password" is not configured')
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
