// Type-level assertions on the PUBLIC surface. Verified by `tsc --noEmit -p
// tests/tsconfig.json` (wired into `pnpm typecheck`), not by vitest — every
// `@ts-expect-error` below fails the build if the error it predicts stops
// happening, so a widened type can't slip through.
//
// This file exists because `tsconfig.json` is `files: []` + project references,
// which never covered `src/runtime/server` — the runtime shipped untypechecked, and
// a `@ts-expect-error` living in a normal `*.test.ts` was silently vacuous.

import type { CfJobsLogEvent, CfJobsLogStage, JobMetricsEvent, JobMetricsEventBase } from '#cf-jobs/server'

const base: JobMetricsEventBase = {
  jobId: 'j1',
  queue: 'crawl',
  jobType: 'crawl/site',
  attempts: 2,
  batchId: null,
  siteId: null,
  userId: null,
}

// ── JobMetricsEvent: discriminated on `status` ──────────────────────────────

const completed: JobMetricsEvent = { ...base, status: 'completed', durationMs: 1, stats: { rowsFetched: 3 } }
const failed: JobMetricsEvent = { ...base, status: 'failed', durationMs: 1, error: 'TypeError: x', cause: new TypeError('x') }
const released: JobMetricsEvent = { ...base, status: 'released', durationMs: null, error: 'rate-limited' }
void completed
void failed
void released

// A completed run has no error and no thrown cause.
// @ts-expect-error `cause` is not on the completed variant
void ({ ...base, status: 'completed', durationMs: 1, stats: {}, cause: new Error('x') } satisfies JobMetricsEvent)
// @ts-expect-error `error` is not on the completed variant
void ({ ...base, status: 'completed', durationMs: 1, stats: {}, error: 'boom' } satisfies JobMetricsEvent)

// A failed run carries a headline and no stats.
// @ts-expect-error `stats` is not on the failed variant
void ({ ...base, status: 'failed', durationMs: 1, error: 'x', stats: {} } satisfies JobMetricsEvent)
// @ts-expect-error `error` is required on the failed variant
void ({ ...base, status: 'failed', durationMs: 1 } satisfies JobMetricsEvent)

// A release is never timed.
// @ts-expect-error `durationMs` must be null on the released variant
void ({ ...base, status: 'released', durationMs: 42 } satisfies JobMetricsEvent)

// Narrowing gives each variant exactly its own fields.
function readsOnlyWhatExists(event: JobMetricsEvent): number {
  if (event.status === 'completed')
    return event.stats.rowsFetched ?? 0
  if (event.status === 'failed')
    return event.cause instanceof Error ? 1 : 0
  return event.error ? 1 : 0
}
void readsOnlyWhatExists

// ── CfJobsLogEvent: `stage` is a closed union, not `string` ─────────────────

const log: CfJobsLogEvent = { stage: 'unexpected', error: 'boom', cause: new Error('boom') }
void log

// @ts-expect-error an unknown stage must not compile
void ({ stage: 'totally-made-up' } satisfies CfJobsLogEvent)

// A consumer's switch is exhaustive: adding a stage upstream breaks the build here
// rather than falling silently into a default branch.
function classify(stage: CfJobsLogStage): 'warn' | 'error' {
  switch (stage) {
    case 'dlq':
    case 'dlq-obsolete': return 'warn'
    case 'invalid_payload':
    case 'unexpected':
    case 'failed':
    case 'dlq-failed':
    case 'continuation-failed':
    case 'onfinish-failed': return 'error'
    default: {
      const exhaustive: never = stage
      return exhaustive
    }
  }
}
void classify
