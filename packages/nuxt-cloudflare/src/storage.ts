import type { Driver, TransactionOptions } from 'unstorage'
import type { KVOptions } from 'unstorage/drivers/cloudflare-kv-binding'
import { defineDriver } from 'unstorage'
import cloudflareKvBindingDriver from 'unstorage/drivers/cloudflare-kv-binding'

export interface CloudflareKvCacheOptions extends KVOptions {
  /** Physical expiry for writes whose caller omitted a TTL, in seconds. */
  defaultTtl: number
}

function parseDefaultTtl(defaultTtl: number): number {
  if (!Number.isSafeInteger(defaultTtl) || defaultTtl < 60)
    throw new Error('Cloudflare KV cache defaultTtl must be an integer of at least 60 seconds')
  return defaultTtl
}

export function withDefaultKvExpiration<Options, Instance>(
  driver: Driver<Options, Instance>,
  defaultTtl: number,
): Driver<Options, Instance> {
  const parsedDefaultTtl = parseDefaultTtl(defaultTtl)
  const setItem = driver.setItem
  if (!setItem)
    throw new Error('Cloudflare KV cache driver must implement setItem')

  return {
    ...driver,
    name: 'cloudflare-kv-binding-expiring-cache',
    flags: { ...driver.flags, ttl: true },
    setItem(key: string, value: string, transactionOptions: TransactionOptions = {}) {
      const requestedTtl = Number(transactionOptions.ttl)
      const ttl = Number.isFinite(requestedTtl) && requestedTtl > 0
        ? requestedTtl
        : parsedDefaultTtl
      return setItem(key, value, { ...transactionOptions, ttl })
    },
  }
}

const cloudflareKvCacheDriver = defineDriver<CloudflareKvCacheOptions, unknown>((options) => {
  const driver: Driver<CloudflareKvCacheOptions, unknown> = {
    ...cloudflareKvBindingDriver(options),
    options,
  }
  return withDefaultKvExpiration(driver, options.defaultTtl)
})

export default cloudflareKvCacheDriver
