/**
 * Request-scoped D1 counters.
 *
 * D1 answers every remote query with a `meta` block naming the node that served
 * it — `served_by_primary`, `served_by_region` — and the session layer here
 * already knows when it had to recover from a reset. Neither fact survives the
 * request unless something records it, and both are exactly what you want when
 * a request is slow or an isolate dies: how many queries did this request make,
 * how many of them crossed to the primary, and did the session have to restart.
 *
 * Kept separate from the session machinery so it stays optional. A caller that
 * wants no telemetry passes no stats object and pays nothing.
 */

export const REQUEST_D1_STATS: unique symbol = Symbol.for('@harlan-zw/nuxt-cloudflare:d1-request-stats')

export interface D1RequestStats {
  /** Terminal statement executions and batches. */
  queries: number
  /** Of those, served by the primary rather than a replica. */
  primaryQueries: number
  /** Sessions restarted after a reset the layer could recover from. */
  recoveries: number
  /** Recoveries that gave up, i.e. the caller saw the error. */
  unrecovered: number
  /** Region of the last node that served a query, e.g. `OC`. */
  region: string | null
  /** Total SQL execution time D1 reported, in milliseconds. */
  durationMs: number
}

export function createD1Stats(): D1RequestStats {
  return { queries: 0, primaryQueries: 0, recoveries: 0, unrecovered: 0, region: null, durationMs: 0 }
}

/**
 * The stats object for this request, created on first use.
 *
 * Takes the request context rather than an `H3Event` so the same helper works
 * in a queue consumer or a scheduled task, which have no event but do have a
 * per-invocation object to hang state on.
 */
export function useD1Stats(requestContext: Record<PropertyKey, unknown>): D1RequestStats {
  const existing = requestContext[REQUEST_D1_STATS]
  if (existing && typeof existing === 'object')
    return existing as D1RequestStats
  const stats = createD1Stats()
  requestContext[REQUEST_D1_STATS] = stats
  return stats
}

/** The stats recorded so far, or `null` when this request never touched D1. */
export function readD1Stats(requestContext: Record<PropertyKey, unknown> | undefined): D1RequestStats | null {
  const stats = requestContext?.[REQUEST_D1_STATS]
  return stats && typeof stats === 'object' ? stats as D1RequestStats : null
}

interface D1ResultMetaLike {
  meta?: {
    served_by_primary?: unknown
    served_by_region?: unknown
    duration?: unknown
  }
}

/**
 * Fold one D1 result's `meta` into the request's counters.
 *
 * Every field is checked before use: `meta` is absent under `wrangler dev` and
 * on a local D1, where these keys do not exist at all, and a telemetry helper
 * that throws in development would be worse than one that records nothing.
 */
export function recordD1Meta(stats: D1RequestStats, result: unknown): void {
  stats.queries++
  const meta = (result as D1ResultMetaLike | null | undefined)?.meta
  if (!meta)
    return
  if (meta.served_by_primary === true)
    stats.primaryQueries++
  if (typeof meta.served_by_region === 'string')
    stats.region = meta.served_by_region
  if (typeof meta.duration === 'number')
    stats.durationMs += meta.duration
}

/** Fold a recovery event into the request's counters. */
export function recordD1Recovery(stats: D1RequestStats, event: { _tag: 'retrying' | 'stopped' }): void {
  stats.recoveries++
  if (event._tag === 'stopped')
    stats.unrecovered++
}
