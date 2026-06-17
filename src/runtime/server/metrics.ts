import type { D1DurableJobRecord, D1DurableJobRepositoryOptions } from './d1'

// ============================================
// Job metrics sink (engine-agnostic core)
// ============================================
//
// A `JobMetricsSink` is the seam for recording per-job telemetry (completion
// time, error rate, retries) to whatever engine a consumer wants — Cloudflare
// Analytics Engine (`#cf-jobs/cloudflare`), a D1 stats table, console, Datadog,
// … The repository already fires fire-and-forget lifecycle hooks; this layer
// just normalizes their snake_case D1 payloads into a stable, transport-neutral
// `JobMetricsEvent` and lets a sink fan out. The CF Analytics Engine adapter is
// the one concrete implementation we ship, behind its own subpath so its
// Workers-specific `writeDataPoint` shape never loads with the core barrel.

export type JobMetricStatus = 'completed' | 'failed' | 'released'

/**
 * One terminal-ish job lifecycle event, engine-neutral. `released` is a
 * deliberate retry (`ctx.release()` / a handler throw) rather than a terminal
 * state, but it is worth recording for retry-rate dashboards.
 */
export interface JobMetricsEvent {
  jobId: string
  queue: string
  jobType: string
  status: JobMetricStatus
  attempts: number
  /** Wall-clock duration when known (completed jobs); null otherwise. */
  durationMs: number | null
  batchId: string | null
  siteId: string | null
  userId: number | null
  /** Present for `failed` / `released` (the release reason). */
  error?: string
  /** Optional completion result supplied by the consumer. */
  result?: unknown
  // Execution stats reported via ctx.reportStats (completed jobs). Undefined when
  // the handler reported none. Recorded as Analytics Engine doubles for sum/avg.
  rowsFetched?: number
  rowsInserted?: number
  d1RowsRead?: number
  d1RowsWritten?: number
}

const STAT_KEYS = ['rowsFetched', 'rowsInserted', 'd1RowsRead', 'd1RowsWritten'] as const

/** Pull the numeric {@link JobRunStats} fields out of a completeJob result. */
function readStats(result: unknown): Partial<Record<(typeof STAT_KEYS)[number], number>> {
  if (!result || typeof result !== 'object')
    return {}
  const out: Partial<Record<(typeof STAT_KEYS)[number], number>> = {}
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

function toEvent(
  job: Pick<D1DurableJobRecord, 'id' | 'queue' | 'job_type' | 'attempts' | 'batch_id' | 'site_id' | 'user_id'>,
  status: JobMetricStatus,
  extra: { durationMs?: number | null, error?: string },
): JobMetricsEvent {
  return {
    jobId: job.id,
    queue: job.queue,
    jobType: job.job_type,
    status,
    attempts: job.attempts,
    durationMs: extra.durationMs ?? null,
    batchId: job.batch_id,
    siteId: job.site_id,
    userId: job.user_id,
    error: extra.error,
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
 * The repo invokes these via its own `fireHook` (swallows sync throws + async
 * rejections), so a misbehaving sink can never break a job's lifecycle.
 */
export function metricsSinkToRepoHooks(
  sink: JobMetricsSink,
): Pick<D1DurableJobRepositoryOptions, 'onJobCompleted' | 'onJobFailed' | 'onJobReleased'> {
  return {
    onJobCompleted({ job, durationMs, result }) {
      const event: JobMetricsEvent = { ...toEvent(job, 'completed', { durationMs }), ...readStats(result) }
      if (result !== undefined)
        event.result = result
      return sink.record(event)
    },
    onJobFailed({ job, error }) {
      return sink.record(toEvent(job, 'failed', { durationMs: job.duration_ms ?? null, error }))
    },
    onJobReleased({ job, opts }) {
      return sink.record(toEvent(job, 'released', { error: opts?.error }))
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
    record(event) {
      for (const sink of sinks) {
        try {
          const result = sink.record(event)
          if (result && typeof (result as Promise<unknown>).then === 'function')
            (result as Promise<unknown>).catch(() => {})
        }
        catch {
          // one sink's failure must not block the rest
        }
      }
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
