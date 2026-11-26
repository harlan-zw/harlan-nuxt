const DEFAULT_MAX_CACHE_ENTRIES = 256

export type AssetDecodeCachePolicy
  = | { _tag: 'Disabled' }
    | { _tag: 'Bounded', revision?: string, maxEntries?: number }

export interface DecodeCollectionAssetOptions {
  /**
   * Caching policy for decoded immutable build assets.
   * Defaults to `Disabled` in development and `Bounded` in production.
   */
  cache?: AssetDecodeCachePolicy
}

interface CachedDecodedAsset {
  bytes: Uint8Array
  revision: string | undefined
  value: unknown
}

const decodedAssetCache = new Map<string, CachedDecodedAsset>()

function defaultCachePolicy(): AssetDecodeCachePolicy {
  // Nitro replaces this expression during the server build.
  // eslint-disable-next-line node/prefer-global/process
  return process.env.NODE_ENV === 'development'
    ? { _tag: 'Disabled' }
    : { _tag: 'Bounded', maxEntries: DEFAULT_MAX_CACHE_ENTRIES }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left === right)
    return true
  if (left.byteLength !== right.byteLength)
    return false
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index])
      return false
  }
  return true
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object')
    return value
  if (!Object.isFrozen(value))
    Object.freeze(value)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++)
      deepFreeze(value[index])
    return value
  }
  for (const child of Object.values(value as Record<string, unknown>))
    deepFreeze(child)
  return value
}

function readCachedAsset<T>(
  collection: string,
  value: Uint8Array,
  revision: string | undefined,
): { _tag: 'Hit', value: T } | { _tag: 'Miss' } {
  const entry = decodedAssetCache.get(collection)
  if (!entry || entry.revision !== revision || !sameBytes(entry.bytes, value))
    return { _tag: 'Miss' }
  // Refresh LRU recency.
  decodedAssetCache.delete(collection)
  decodedAssetCache.set(collection, entry)
  return { _tag: 'Hit', value: entry.value as T }
}

function writeCachedAsset(
  collection: string,
  entry: CachedDecodedAsset,
  maxEntries: number,
): void {
  if (!Number.isFinite(maxEntries) || maxEntries <= 0)
    return
  decodedAssetCache.delete(collection)
  while (decodedAssetCache.size >= maxEntries) {
    const oldest = decodedAssetCache.keys().next().value
    if (oldest === undefined)
      break
    decodedAssetCache.delete(oldest)
  }
  decodedAssetCache.set(collection, entry)
}

/** Clears the in-memory cache of decoded collection assets. */
export function clearDecodedCollectionAssetCache(): void {
  decodedAssetCache.clear()
}

export function decodeCollectionAsset<T>(
  value: Uint8Array,
  collection: string,
  options?: DecodeCollectionAssetOptions,
): Promise<T> {
  const policy = options?.cache ?? defaultCachePolicy()
  if (policy._tag === 'Bounded') {
    const hit = readCachedAsset<T>(collection, value, policy.revision)
    if (hit._tag === 'Hit')
      return Promise.resolve(hit.value)
  }

  const bytes = Uint8Array.from(value)
  const stream = new Blob([bytes.buffer]).stream().pipeThrough(new DecompressionStream('gzip'))
  // Never cache an unsettled promise: on Cloudflare Workers, a cancelled request
  // leaves a shared in-flight promise permanently unsettled for later requests.
  return new Response(stream).text().then((text) => {
    const parsed = JSON.parse(text) as T
    if (policy._tag === 'Bounded') {
      const frozen = deepFreeze(parsed)
      writeCachedAsset(
        collection,
        { bytes, revision: policy.revision, value: frozen },
        policy.maxEntries ?? DEFAULT_MAX_CACHE_ENTRIES,
      )
      return frozen
    }
    return parsed
  }).catch((cause) => {
    throw new TypeError(`${collection}.json.gz:1:1 Could not decode the generated collection asset.`, { cause })
  })
}
