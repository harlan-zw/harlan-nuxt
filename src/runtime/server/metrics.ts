import type { D1DurableJobRecord, D1DurableJobRepositoryOptions } from './d1'
import type { JobRunStats } from './types'

// ============================================
// Job metrics sink (engine-agnostic core)
// ============================================
//
// A `JobMetricsSink` is the seam for recording per-job telemetry (completion
// time, error rate, retries) to whatever engine a consumer wants — Cloudflare
// Analytics Engine (`#cf-jobs/cloudflare`), a D1 stats table, console, Datadog,
// … The repository awaits lifecycle hooks while isolating their failures; this
// layer normalizes snake_case D1 payloads into a stable, transport-neutral
// `JobMetricsEvent` and lets a sink fan out. The CF Analytics Engine adapter is
// the one concrete implementation we ship, behind its own subpath so its
// Workers-specific `writeDataPoint` shape never loads with the core barrel.

/** Fields every lifecycle event carries, whatever its outcome. */
export interface JobMetricsEventBase {
  jobId: string
  queue: string
  jobType: string
  attempts: number
  batchId: string | null
  siteId: string | null
  userId: number | null
}

/**
 * One terminal-ish job lifecycle event, engine-neutral, discriminated on `status`
 * so a sink can only read the fields that outcome actually has. `released` is a
 * deliberate retry (`ctx.release()`) rather than a terminal state, but it is worth
 * recording for retry-rate dashboards.
 *
 * Previously this was one interface with `error?`/`cause?`/`result?`/`rows*?` all
 * optional, which made `{ status: 'completed', cause }` and `{ status: 'failed',
 * rowsInserted }` representable — and the Analytics Engine adapter duly wrote an
 * `error` blob and zero-filled stat doubles for completed jobs. The union removes
 * both the illegal states and the guesswork.
 */
export type JobMetricsEvent
  = | (JobMetricsEventBase & {
    status: 'completed'
    /** Wall-clock duration when the repository timed the run. */
    durationMs: number | null
    /** Whatever the consumer's `completeJob` returned. */
    result?: unknown
    /** Execution stats from `ctx.reportStats`; `{}` when the handler reported none. */
    stats: JobRunStats
  })
  | (JobMetricsEventBase & {
    status: 'failed'
    durationMs: number | null
    /** Single-line headline (`"TypeError: <message>"`) — safe for titles + blobs. */
    error: string
    /**
     * The ORIGINAL thrown value, not a rendering of it. An error-tracker sink should
     * `captureException(cause)` so it groups on the real throw site and keeps the
     * native stack + `cause` chain, rather than rebuilding a synthetic
     * `new Error(error)`. Absent when the failure never had a throw (a dispatch
     * fault, `ctx.fail()`). Dimension-oriented sinks must ignore it — it is an
     * arbitrary object, not a blob.
     */
    cause?: unknown
  })
  | (JobMetricsEventBase & {
    status: 'released'
    /** A release is not a completed run, so it is never timed. */
    durationMs: null
    /** The release reason, when `ctx.release()` supplied one. */
    error?: string
  })

export type JobMetricStatus = JobMetricsEvent['status']

const STAT_KEYS = ['rowsFetched', 'rowsInserted', 'd1RowsRead', 'd1RowsWritten'] as const

/** Pull the numeric {@link JobRunStats} fields out of a completeJob result. */
function readStats(result: unknown): JobRunStats {
  if (!result || typeof result !== 'object')
    return {}
  const out: JobRunStats = {}
  for (const k of STAT_KEYS) {
    const v = (result as Record<string, unknown>)[k]
    if (typeof v === 'number')
      out[k] = v
  }
  return out
}

export interface JobMetricsSink {
  record: (event: JobMetricsEvent) => void | Promise<void>
}

/** The status-independent half of an event, lifted off the repository's D1 row. */
function baseOf(
  job: Pick<D1DurableJobRecord, 'id' | 'queue' | 'job_type' | 'attempts' | 'batch_id' | 'site_id' | 'user_id'>,
): JobMetricsEventBase {
  return {
    jobId: job.id,
    queue: job.queue,
    jobType: job.job_type,
    attempts: job.attempts,
    batchId: job.batch_id,
    siteId: job.site_id,
    userId: job.user_id,
  }
}

/**
 * Adapt a {@link JobMetricsSink} to the repository's lifecycle hooks. Spread the
 * result into {@link D1DurableJobRepositoryOptions}:
 *
 * ```ts
 * createD1DurableJobRepository(db, { ...metricsSinkToRepoHooks(sink) })
 * ```
 *
 * The repo awaits these while swallowing sync throws + async rejections, so the
 * Worker keeps them alive without allowing a misbehaving sink to break a job.
 */
export function metricsSinkToRepoHooks(
  sink: JobMetricsSink,
): Pick<D1DurableJobRepositoryOptions, 'onJobCompleted' | 'onJobFailed' | 'onJobReleased'> {
  return {
    onJobCompleted({ job, durationMs, result }) {
      return sink.record({
        ...baseOf(job),
        status: 'completed',
        durationMs: durationMs ?? null,
        stats: readStats(result),
        ...(result !== undefined ? { result } : {}),
      })
    },
    onJobFailed({ job, error, cause }) {
      return sink.record({
        ...baseOf(job),
        status: 'failed',
        durationMs: job.duration_ms ?? null,
        error,
        ...(cause !== undefined ? { cause } : {}),
      })
    },
    onJobReleased({ job, opts }) {
      return sink.record({
        ...baseOf(job),
        status: 'released',
        durationMs: null,
        ...(opts?.error !== undefined ? { error: opts.error } : {}),
      })
    },
  }
}

/**
 * Fan an event out to several sinks, isolating each so one throwing/rejecting
 * sink never starves the others (the repo guards the outermost call, but a sink
 * combined here is also reachable directly).
 */
export function combineMetricsSinks(...sinks: JobMetricsSink[]): JobMetricsSink {
  return {
    async record(event) {
      await Promise.all(sinks.map(async (sink) => {
        try {
          await sink.record(event)
        }
        catch {
          // one sink's failure must not block the rest
        }
      }))
    },
  }
}

/**
 * A console sink — a zero-dependency default for local dev where no real metrics
 * engine binding exists. Pass your own `log` to route elsewhere.
 */
export function createConsoleMetricsSink(
  // eslint-disable-next-line no-console -- debug is the intended default sink for dev metrics
  log: (event: JobMetricsEvent) => void = event => console.debug('[cf-jobs:metric]', event),
): JobMetricsSink {
  return { record: log }
}

/** A sink that records nothing — the safe default when metrics are unconfigured. */
export const noopMetricsSink: JobMetricsSink = { record() {} }
