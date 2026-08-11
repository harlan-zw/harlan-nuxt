import type { CloudflareEventLike } from '../src/bindings'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { getCloudflareBinding, requireCloudflareBinding } from '../src/bindings'

interface TestEnvironment {
  DB: { marker: 'db' }
  OPTIONAL_CACHE?: { marker: 'cache' }
}

describe('cloudflare bindings', () => {
  it('reads bindings only from the explicit request environment', () => {
    const event: CloudflareEventLike<{ DB: { marker: string }, MISSING?: never }> = { context: { cloudflare: { env: { DB: { marker: 'db' } } } } }
    expect(getCloudflareBinding(event, 'DB')).toEqual({ marker: 'db' })
    expect(getCloudflareBinding(event, 'MISSING')).toBeUndefined()
  })

  it('fails loudly for a required missing binding', () => {
    const event: CloudflareEventLike<{ DB: unknown }> = { context: {} }
    expect(() => requireCloudflareBinding(event, 'DB')).toThrow('Cloudflare binding "DB" is unavailable')
  })

  it('derives binding names and values from the generated environment type', () => {
    const event: CloudflareEventLike<TestEnvironment> = { context: { cloudflare: { env: { DB: { marker: 'db' } } } } }
    expectTypeOf(requireCloudflareBinding(event, 'DB')).toEqualTypeOf<{ marker: 'db' }>()
    expectTypeOf(getCloudflareBinding(event, 'OPTIONAL_CACHE')).toEqualTypeOf<{ marker: 'cache' } | undefined>()

    if (false) {
      // @ts-expect-error unknown binding names must be rejected by the generated environment type.
      requireCloudflareBinding(event, 'TYPO')
    }
  })
})
