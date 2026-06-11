import type { D1DatabaseLike } from './d1'
import type { QueueJobMessage } from './outbox'

/**
 * Pure core for the dev worker (`cf-jobs work` → `POST /__cf-jobs/work`).
 *
 * The dev worker exists so a `nuxt dev` server can run durable jobs *out-of-band*
 * from the request that enqueued them — the only way an already-connected
 * WebSocket can observe live job progress. Cloudflare's real consumer is a
 * separate Worker invocation; in `nuxt dev` everything shares one process, so a
 * job only reaches an in-memory WS subscription map if it runs *inside* the dev
 * server. The worker therefore never executes handlers itself: it finds ready
 * durable jobs in D1 and drives the app's registered `cloudflare:queue` consumer
 * in-process (via {@link DevWorkerDeps.dispatchBatch}), which claims and runs
 * them with the app's real context. This module is the data-in/data-out core; the
 * nitro/D1 wiring lives in the route handler.
 */

/** Cloudflare's default `[[queues.consumers]].max_batch_size`. */
const DEFAULT_MAX_BATCH_SIZE = 10
/** Conservative default (matches Cloudflare's serial-by-default behaviour). */
const DEFAULT_MAX_CONCURRENCY = 1

export interface DevWorkerQueueConfig {
  /** Wrangler `max_concurrency`: how many batches of this queue drain at once. */
  maxConcurrency: number
  /** Wrangler `max_batch_size`: messages handed to one consumer invocation. */
  maxBatchSize: number
}

export interface DevWorkerDeps<Queue extends string = string> {
  /** Ready (unreserved, available, not terminal) durable jobs, oldest first, up to `limit`. */
  findDispatchable: (limit: number) => Promise<ReadonlyArray<{ id: string, queue: Queue }>>
  /**
   * Drive one consumer invocation in-process — fires the `cloudflare:queue` hook
   * and AWAITS it, so the handler runs (and broadcasts) before the tick returns.
   */
  dispatchBatch: (queue: Queue, messages: ReadonlyArray<QueueJobMessage<Queue>>) => Promise<void>
  /** Per-queue sizing — "match the queue" off the wrangler consumer config. */
  queueConfig: (queue: Queue) => DevWorkerQueueConfig
}

export interface DevWorkerTickResult {
  /** Jobs handed to a consumer this tick (≈ processed; the consumer ran them inline). */
  processed: number
  /** Per-logical-queue counts. */
  byQueue: Record<string, number>
  /** Ready jobs still waiting after this tick (lets the CLI decide to keep going). */
  remaining: number
}

export interface DevWorkerTickOptions {
  /** Max jobs claimed per tick. */
  limit: number
  /** Restrict the tick to a single logical queue. */
  queue?: string
}

// --- Worker-active lease ------------------------------------------------------
// The dev queue must NOT auto-run a job (microtask dispatch) while `cf-jobs work`
// is draining out-of-band, or the job runs twice / before the worker sees it.
// Rather than a pid/lockfile that two processes have to agree on a path for, we
// lean on the fact that the worker already POLLS `/__cf-jobs/work` every tick:
// each poll refreshes an in-process lease (`markWorkerActive`), and the dev-queues
// plugin checks `isWorkerActive()` before auto-firing. The handler and the plugin
// share this module instance in the one dev nitro process, so no fs/IPC is needed
// and a stopped worker self-heals when the lease expires.

let workerActiveUntil = 0

/** Lease longer than the worker's max idle poll interval (5s) so it never lapses mid-run. */
const DEFAULT_WORKER_LEASE_MS = 15_000

/** Called on every worker poll — extends the window during which the dev queue defers. */
export function markWorkerActive(ttlMs: number = DEFAULT_WORKER_LEASE_MS, now: number = Date.now()): void {
  workerActiveUntil = now + ttlMs
}

/** True while a recent worker poll keeps the lease alive — dev queue should defer auto-dispatch. */
export function isWorkerActive(now: number = Date.now()): boolean {
  return now < workerActiveUntil
}

/** Derive per-queue sizing from a `cfJobs.queues` entry (string binding or options object). */
export function resolveQueueWorkerConfig(
  entry: string | { maxConcurrency?: number, maxBatchSize?: number } | undefined,
): DevWorkerQueueConfig {
  if (!entry || typeof entry === 'string')
    return { maxConcurrency: DEFAULT_MAX_CONCURRENCY, maxBatchSize: DEFAULT_MAX_BATCH_SIZE }
  return {
    maxConcurrency: clampPositive(entry.maxConcurrency, DEFAULT_MAX_CONCURRENCY),
    maxBatchSize: clampPositive(entry.maxBatchSize, DEFAULT_MAX_BATCH_SIZE),
  }
}

function clampPositive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, size)
  const out: T[][] = []
  for (let i = 0; i < items.length; i += step)
    out.push(items.slice(i, i + step))
  return out
}

/** Run `tasks` with at most `concurrency` in flight (a simple slot pool). */
export async function runWithConcurrency<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const limit = Math.max(1, concurrency)
  const results: T[] = Array.from({ length: tasks.length })
  let cursor = 0
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++
      if (index >= tasks.length)
        return
      results[index] = await tasks[index]!()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  return results
}

export async function runDevWorkerTick<Queue extends string = string>(
  deps: DevWorkerDeps<Queue>,
  opts: DevWorkerTickOptions,
): Promise<DevWorkerTickResult> {
  const ready = await deps.findDispatchable(opts.limit)
  const filtered = opts.queue ? ready.filter(r => r.queue === opts.queue) : ready

  const byQueue: Record<string, number> = {}
  if (filtered.length === 0)
    return { processed: 0, byQueue, remaining: 0 }

  // Group by logical queue so each drains with its own wrangler sizing.
  const groups = new Map<Queue, Array<QueueJobMessage<Queue>>>()
  for (const record of filtered) {
    const messages = groups.get(record.queue) ?? []
    messages.push({ jobId: record.id, queue: record.queue })
    groups.set(record.queue, messages)
  }

  let processed = 0
  await Promise.all([...groups].map(async ([queue, messages]) => {
    const { maxConcurrency, maxBatchSize } = deps.queueConfig(queue)
    const batches = chunk(messages, maxBatchSize)
    await runWithConcurrency(
      batches.map(batch => () => deps.dispatchBatch(queue, batch)),
      maxConcurrency,
    )
    byQueue[queue] = messages.length
    processed += messages.length
  }))

  // Re-read so the CLI knows whether another tick is worth it — we may have
  // capped at `limit`, or a multi-stage job released a now-ready continuation.
  const after = await deps.findDispatchable(opts.limit)
  const remaining = opts.queue ? after.filter(r => r.queue === opts.queue).length : after.length

  return { processed, byQueue, remaining }
}

export interface D1BindingMatch {
  binding: string
  db: D1DatabaseLike
  /** Set when more than one D1 binding exists and the first was picked. */
  ambiguous?: string[]
}

/** Resolve the durable-jobs D1 database off the runtime env (auto-detect, or by name). */
export function findD1Binding(
  env: Record<string, unknown>,
  preferred?: string,
): D1BindingMatch | undefined {
  if (preferred) {
    const db = env[preferred]
    return isD1Database(db) ? { binding: preferred, db } : undefined
  }
  const matches = Object.entries(env).filter((entry): entry is [string, D1DatabaseLike] => isD1Database(entry[1]))
  const first = matches[0]
  if (!first)
    return undefined
  return matches.length > 1
    ? { binding: first[0], db: first[1], ambiguous: matches.map(([name]) => name) }
    : { binding: first[0], db: first[1] }
}

function isD1Database(value: unknown): value is D1DatabaseLike {
  return !!value && typeof value === 'object'
    && typeof (value as { prepare?: unknown }).prepare === 'function'
    && typeof (value as { exec?: unknown }).exec === 'function'
}
