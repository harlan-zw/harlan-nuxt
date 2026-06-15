// "Try again" for a terminal job failure, by RE-DISPATCH.
//
// The SQL-level retry (`retrySql`, used by the `cf-jobs retry` CLI) only moves a
// `failed_jobs` row back into `jobs` with attempts reset. On Cloudflare Queues
// that row is never handed to a consumer again — nothing sends the
// `{ jobId, queue }` message — so it just sits there. That's fine for a worker
// that polls `jobs` itself, but wrong for the dispatch-on-enqueue model.
//
// This reconstructs a FRESH durable job from the stored `_task` envelope (which
// DOES dispatch) and forgets the failed row. The host injects the storage +
// enqueue seams; the cf-jobs convention (the `_task`/`_continuations` envelope,
// and "only forget after a successful re-enqueue") lives here.

/**
 * Recover the original job name + clean input from a stored payload envelope
 * (`failed_jobs.payload`). Mirrors the dispatcher's own unwrapping
 * (`{ _task, _continuations, ...payload }`): `_continuations` is internal batch
 * wiring and is intentionally dropped so a manual retry can't double-fire a
 * stale onFinish chain.
 */
export function parseFailedJobEnvelope(
  payloadJson: string,
):
  | { _tag: 'ok', name: string, payload: Record<string, unknown> }
  | { _tag: 'no-task' }
  | { _tag: 'invalid-json' } {
  let parsed: unknown
  try {
    parsed = JSON.parse(payloadJson)
  }
  catch {
    return { _tag: 'invalid-json' }
  }
  if (!parsed || typeof parsed !== 'object')
    return { _tag: 'invalid-json' }
  const { _task, _continuations, ...payload } = parsed as {
    _task?: unknown
    _continuations?: unknown
    [key: string]: unknown
  }
  if (typeof _task !== 'string' || _task.length === 0)
    return { _tag: 'no-task' }
  return { _tag: 'ok', name: _task, payload }
}

export interface RedispatchFailedJobDeps {
  /**
   * Load the stored payload envelope for the failed job, or `null` if no such
   * record exists / is visible to the caller. The host owns the query (and any
   * scoping such as `site_id`/`user_id`).
   */
  loadFailure: () => Promise<{ payload: string } | null>
  /**
   * Re-enqueue a FRESH durable job that actually dispatches, returning the new
   * job id. Typically the host's durable-enqueue wrapper.
   */
  enqueue: (name: string, payload: Record<string, unknown>) => Promise<string>
  /** Forget the terminal failed record. Only called after a successful re-enqueue. */
  forget: () => Promise<void>
}

export type RedispatchFailedJobResult
  = | { _tag: 'redispatched', name: string, jobId: string }
    | { _tag: 'not-found' }
    | { _tag: 'not-retryable' }

/**
 * Retry a terminal failure by re-dispatching it. Returns a tagged result rather
 * than throwing for the expected domain outcomes (`not-found`, `not-retryable`);
 * infra failures from the injected seams propagate.
 *
 * The failed record is only forgotten AFTER a successful `enqueue`, so a dropped
 * re-enqueue leaves the failure visible to retry again rather than silently
 * losing the job.
 */
export async function redispatchFailedJob(
  deps: RedispatchFailedJobDeps,
): Promise<RedispatchFailedJobResult> {
  const row = await deps.loadFailure()
  if (!row)
    return { _tag: 'not-found' }

  const envelope = parseFailedJobEnvelope(row.payload)
  if (envelope._tag !== 'ok')
    return { _tag: 'not-retryable' }

  const jobId = await deps.enqueue(envelope.name, envelope.payload)
  await deps.forget()
  return { _tag: 'redispatched', name: envelope.name, jobId }
}
