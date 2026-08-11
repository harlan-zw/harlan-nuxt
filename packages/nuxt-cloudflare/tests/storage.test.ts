import type { Driver } from 'unstorage'
import { describe, expect, it, vi } from 'vitest'
import { withDefaultKvExpiration } from '../src/storage'

function driver(setItem: Driver['setItem']): Driver {
  return {
    name: 'test',
    hasItem: async () => false,
    getItem: async () => null,
    getKeys: async () => [],
    setItem,
  }
}

describe('withDefaultKvExpiration', () => {
  it('adds physical expiry only when a cache write omitted a TTL', async () => {
    const setItem = vi.fn(async () => {})
    const wrapped = withDefaultKvExpiration(driver(setItem), 30 * 24 * 60 * 60)

    await wrapped.setItem?.('cold', 'value', {})
    await wrapped.setItem?.('explicit', 'value', { ttl: 120 })

    expect(setItem).toHaveBeenNthCalledWith(1, 'cold', 'value', { ttl: 2_592_000 })
    expect(setItem).toHaveBeenNthCalledWith(2, 'explicit', 'value', { ttl: 120 })
  })

  it('rejects Cloudflare KV expiry below the platform minimum', () => {
    expect(() => withDefaultKvExpiration(driver(async () => {}), 59)).toThrow(/at least 60 seconds/)
  })

  it('raises caller TTLs to the Cloudflare KV platform minimum', async () => {
    const setItem = vi.fn(async () => {})
    const wrapped = withDefaultKvExpiration(driver(setItem), 30 * 24 * 60 * 60)

    await wrapped.setItem?.('short', 'value', { ttl: 1 })

    expect(setItem).toHaveBeenCalledWith('short', 'value', { ttl: 60 })
  })
})
