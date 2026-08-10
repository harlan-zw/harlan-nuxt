// Private helpers shared across runtime modules. NOT re-exported from `index.ts`,
// so these stay out of the public `#cf-jobs/server` surface.

/** Cloudflare Queues hard cap on `delaySeconds` (24 hours). */
export const CF_QUEUE_MAX_DELAY_SECONDS = 86400

/**
 * Deterministic stringify used for dedup keys and unique-key hashing. Sorts object
 * keys and handles `bigint`/`Date` (plain `JSON.stringify` throws on `bigint`).
 */
export function stableStringify(value: unknown): string {
  if (typeof value === 'bigint')
    return `"@bigint:${value.toString()}"`
  if (value instanceof Date)
    return `"@date:${value.toISOString()}"`
  if (Array.isArray(value))
    return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
