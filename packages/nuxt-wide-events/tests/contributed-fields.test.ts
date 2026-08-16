import { describe, expect, it } from 'vitest'
import { createWideEventFieldRegistry } from '../src/build/contributed-fields'
import { resolveWideEventFields } from '../src/build/fields'

describe('module-contributed fields', () => {
  it('collects fields from several modules in declaration order', () => {
    const collected = createWideEventFieldRegistry()

    collected.registry.add('@harlan-zw/nuxt-cloudflare', ['cf.colo', 'd1.queries'])
    collected.registry.add('some/other-module', ['queue.name'])

    expect(collected.fields).toEqual(['cf.colo', 'd1.queries', 'queue.name'])
    expect(collected.contributors.get('cf.colo')).toBe('@harlan-zw/nuxt-cloudflare')
    expect(collected.contributors.get('queue.name')).toBe('some/other-module')
  })

  it('keeps the first contributor of a shared field instead of failing the build', () => {
    const collected = createWideEventFieldRegistry()

    // Two modules recording the same well-known field agree; they do not
    // conflict, and an application should not fail for installing both.
    collected.registry.add('module/a', ['cf.colo'])
    collected.registry.add('module/b', ['cf.colo'])

    expect(collected.fields).toEqual(['cf.colo'])
    expect(collected.contributors.get('cf.colo')).toBe('module/a')
  })

  it('joins the application allowlist, and is validated by the same rules', () => {
    const collected = createWideEventFieldRegistry()
    collected.registry.add('@harlan-zw/nuxt-cloudflare', ['cf.colo'])

    expect(resolveWideEventFields(['user.id', ...collected.fields])).toEqual({
      _tag: 'Ok',
      fields: ['user.id', 'cf.colo'],
    })

    // A module gets no exemption: a reserved name is still reserved, so a
    // module cannot quietly redefine `status` or `path` for every consumer.
    const reserved = createWideEventFieldRegistry()
    reserved.registry.add('module/a', ['status'])
    expect(resolveWideEventFields([...reserved.fields])).toEqual({
      _tag: 'Err',
      issues: [{ _tag: 'ReservedField', field: 'status' }],
    })

    // And a malformed name from a module fails the same way it would from an app.
    const malformed = createWideEventFieldRegistry()
    malformed.registry.add('module/a', ['CF.Colo'])
    expect(resolveWideEventFields([...malformed.fields])).toEqual({
      _tag: 'Err',
      issues: [{ _tag: 'InvalidField', field: 'CF.Colo' }],
    })
  })

  it('reports an application field duplicated by a module', () => {
    const collected = createWideEventFieldRegistry()
    collected.registry.add('@harlan-zw/nuxt-cloudflare', ['cf.colo'])

    // The app already listed it by hand. Surfacing this is the point: the app
    // should delete its copy, and silence would leave two owners for one field.
    expect(resolveWideEventFields(['cf.colo', ...collected.fields])).toEqual({
      _tag: 'Err',
      issues: [{ _tag: 'DuplicateField', field: 'cf.colo' }],
    })
  })
})
