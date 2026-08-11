import { describe, expect, it } from 'vitest'
import { getCloudflareBinding, requireCloudflareBinding } from '../src/bindings'

describe('cloudflare bindings', () => {
  it('reads bindings only from the explicit request environment', () => {
    const event = { context: { cloudflare: { env: { DB: { marker: 'db' } } } } }
    expect(getCloudflareBinding(event, 'DB')).toEqual({ marker: 'db' })
    expect(getCloudflareBinding(event, 'MISSING')).toBeUndefined()
  })

  it('fails loudly for a required missing binding', () => {
    expect(() => requireCloudflareBinding({ context: {} }, 'DB')).toThrow('Cloudflare binding "DB" is unavailable')
  })
})
