import type {
  DispatchDurableJobBatchResult,
  DurableJobRecord,
  DurableJobRecoveryRepository,
  QueuePublisher,
} from './outbox'
import {
  dispatchDurableJobBatch,
  failStaleReservedDurableJobs,
  findDispatchableDurableJobs,
  releaseStaleReservedDurableJobs,
} from './outbox'

export interface RecoverDurableJobsOptions {
  now?: number
  staleSeconds?: number
  orphanedSeconds?: number
  /** Let the original CF message reclaim a reaped row before dispatching a duplicate. Defaults to 120s. */
  redeliveryGraceSeconds?: number
  limit?: number
  staleError?: string
  /** Settle batches or publish telemetry for rows terminalized by the stale reaper. */
  onTerminalized?: (jobs: Array<{ id: string, queue: string, batchId: string | null }>) => void | Promise<void>
}

export interface RecoverDurableJobsResult<Queue extends string = string> {
  released: number
  terminalized: number
  terminalizedJobs: Array<{ id: string, queue: Queue, batchId: string | null }>
  swept: number
  dispatched: number
  stale: Array<Pick<DurableJobRecord<Queue>, 'id' | 'queue'>>
  orphaned: Array<Pick<DurableJobRecord<Queue>, 'id' | 'queue'>>
  dispatchable: Array<Pick<DurableJobRecord<Queue>, 'id' | 'queue'>>
  dispatchResults: Array<DispatchDurableJobBatchResult<Queue>>
}

export async function recoverDurableJobs<
  Queue extends string,
  Record extends Pick<DurableJobRecord<Queue>, 'id' | 'queue'>,
>(
  repository: DurableJobRecoveryRepository<Queue, Record>,
  publisher: Pick<QueuePublisher<Queue>, 'sendBatch'>,
  opts: RecoverDurableJobsOptions = {},
): Promise<RecoverDurableJobsResult<Queue>> {
  const nowSeconds = opts.now ?? Math.floor(Date.now() / 1000)
  const staleSeconds = opts.staleSeconds ?? 300
  const orphanedSeconds = opts.orphanedSeconds ?? 600
  const redeliveryGraceSeconds = Math.max(0, opts.redeliveryGraceSeconds ?? 120)
  const limit = opts.limit ?? 100
  const staleBefore = nowSeconds - staleSeconds

  // Terminalize exhausted stale reservations FIRST (move them to failed_jobs).
  // Doing this before the find/release below means the revive path only ever
  // sees still-retriable jobs, so an `attempts >= max_attempts` job can't be
  // re-dispatched into an endless reaper → stale → reaper loop.
  const terminalizedJobs = await failStaleReservedDurableJobs(repository, {
    now: nowSeconds,
    staleBefore,
    error: opts.staleError ? `${opts.staleError}: exhausted retries` : 'exhausted retries',
    limit,
  })
  if (terminalizedJobs.length > 0)
    await opts.onTerminalized?.(terminalizedJobs)

  const stale = await repository.findStaleReservedJobs?.({
    staleBefore,
    limit,
  }) ?? []

  const released = await releaseStaleReservedDurableJobs(repository, {
    now: nowSeconds,
    staleBefore,
    availableAt: nowSeconds,
    error: opts.staleError ?? 'stale-reservation',
    limit,
  })

  const orphaned = await findDispatchableDurableJobs(repository, {
    now: nowSeconds,
    createdBefore: nowSeconds - orphanedSeconds,
    ...(redeliveryGraceSeconds > 0 ? { staleReleasedBefore: nowSeconds - redeliveryGraceSeconds } : {}),
    limit,
  })

  const releasedIds = new Set(stale.slice(0, released).map(job => job.id))
  const dispatchable = uniqueJobs(redeliveryGraceSeconds > 0
    ? orphaned.filter(job => !releasedIds.has(job.id))
    : [...stale.slice(0, released), ...orphaned])
  const dispatchResults = await dispatchDurableJobBatch(publisher, dispatchable)

  return {
    released,
    terminalized: terminalizedJobs.length,
    terminalizedJobs,
    swept: dispatchable.length,
    dispatched: dispatchResults.filter(result => result.status === 'sent').length,
    stale,
    orphaned,
    dispatchable,
    dispatchResults,
  }
}

function uniqueJobs<Queue extends string>(
  jobs: Array<Pick<DurableJobRecord<Queue>, 'id' | 'queue'>>,
): Array<Pick<DurableJobRecord<Queue>, 'id' | 'queue'>> {
  const seen = new Set<string>()
  return jobs.filter((job) => {
    if (seen.has(job.id))
      return false
    seen.add(job.id)
    return true
  })
}
