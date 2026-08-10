import type { JobMetricsEvent, JobMetricsSink } from './metrics'
import { noopMetricsSink } from './metrics'

// ============================================
// Cloudflare Analytics Engine sink (#cf-jobs/cloudflare)
// ============================================
//
// The one concrete {@link JobMetricsSink} we ship. Lives on its own subpath so
// the Workers-specific `writeDataPoint` shape (and the `AnalyticsEngineDataset`
// binding type) never loads with the engine-neutral `#cf-jobs/server` barrel.
// Analytics Engine is the right home for this telemetry: append-only, time-
// series, high-cardinality, cheap, SQL-queryable — and it keeps job dashboards
// alive after the durable D1 rows are pruned. It is write-only blobs (no per-row
// lookups), so it complements `failed_jobs` rather than replacing it.

/**
 * Minimal structural shape of a Cloudflare Analytics Engine binding
 * (`AnalyticsEngineDataset`). Declared locally so this module needs no
 * `@cloudflare/workers-types` dependency; the real binding is assignable.
 */
export interface AnalyticsEngineDataset {
  writeDataPoint: (point: {
    indexes?: string[]
    blobs?: Array<string | null>
    doubles?: number[]
  }) => void
}

export type AnalyticsEngineDataPoint = Parameters<AnalyticsEngineDataset['writeDataPoint']>[0]

export interface AnalyticsEngineSinkOptions {
  /**
   * Override the event → data-point mapping. Mind the Analytics Engine limits:
   * at most ONE index (≤96 bytes), ≤20 doubles, and blobs totalling ≤5120 bytes.
   */
  toDataPoint?: (event: JobMetricsEvent) => AnalyticsEngineDataPoint
}

/**
 * Default mapping. `queue` is the single index (the natural rollup key); status
 * and jobType ride as blobs for filtering; duration + attempts as doubles for
 * latency/retry aggregates.
 */
export function defaultJobDataPoint(event: JobMetricsEvent): AnalyticsEngineDataPoint {
  // Narrow rather than guess: only a completed run has stats, and only a
  // failed/released one has an error. `cause` is an arbitrary thrown object and is
  // deliberately never written (blobs total ≤5120 bytes).
  const stats = event.status === 'completed' ? event.stats : undefined
  const error = event.status === 'completed' ? null : event.error ?? null
  return {
    indexes: [event.queue],
    blobs: [event.queue, event.jobType, event.status, error],
    // doubles are positional — keep this order stable (the AE SQL API references
    // double1..double6). duration, attempts, then the reported execution stats.
    doubles: [
      event.durationMs ?? 0,
      event.attempts,
      stats?.rowsFetched ?? 0,
      stats?.rowsInserted ?? 0,
      stats?.d1RowsRead ?? 0,
      stats?.d1RowsWritten ?? 0,
    ],
  }
}

/** Build a sink that writes each event to the given Analytics Engine dataset. */
export function createAnalyticsEngineSink(
  dataset: AnalyticsEngineDataset,
  opts: AnalyticsEngineSinkOptions = {},
): JobMetricsSink {
  const toDataPoint = opts.toDataPoint ?? defaultJobDataPoint
  return {
    record(event) {
      dataset.writeDataPoint(toDataPoint(event))
    },
  }
}

export interface ResolveAnalyticsEngineSinkOptions extends AnalyticsEngineSinkOptions {
  /** Env binding name of the Analytics Engine dataset (e.g. `'JOB_ANALYTICS'`). */
  binding: string
  /**
   * Sink used when the binding is absent (local dev / not yet provisioned) — so
   * wiring this in is a safe no-op until the dataset exists. Defaults to
   * {@link noopMetricsSink}; pass `createConsoleMetricsSink()` for dev logs.
   */
  fallback?: JobMetricsSink
}

/**
 * Resolve an Analytics Engine sink from a Workers `env`, degrading to a fallback
 * (no-op by default) when the binding is missing or malformed. This is the
 * "provide the binding name, it just works" entry point — drop it straight into
 * a repository's hooks via `metricsSinkToRepoHooks`.
 */
export function resolveAnalyticsEngineSink(
  env: Record<string, unknown> | undefined,
  opts: ResolveAnalyticsEngineSinkOptions,
): JobMetricsSink {
  const dataset = env?.[opts.binding] as AnalyticsEngineDataset | undefined
  if (dataset && typeof dataset.writeDataPoint === 'function')
    return createAnalyticsEngineSink(dataset, opts)
  return opts.fallback ?? noopMetricsSink
}
