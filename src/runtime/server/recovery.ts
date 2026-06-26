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
  limit?: number
  staleError?: string
}

export interface RecoverDurableJobsResult<Queue extends string = string> {
  released: number
  terminalized: number
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
  const limit = opts.limit ?? 100
  const staleBefore = nowSeconds - staleSeconds

  // Terminalize exhausted stale reservations FIRST (move them to failed_jobs).
  // Doing this before the find/release below means the revive path only ever
  // sees still-retriable jobs, so an `attempts >= max_attempts` job can't be
  // re-dispatched into an endless reaper → stale → reaper loop.
  const terminalized = await failStaleReservedDurableJobs(repository, {
    staleBefore,
    error: opts.staleError ? `${opts.staleError}: exhausted retries` : 'exhausted retries',
    limit,
  })

  const stale = await repository.findStaleReservedJobs?.({
    staleBefore,
    limit,
  }) ?? []

  const released = await releaseStaleReservedDurableJobs(repository, {
    staleBefore,
    availableAt: nowSeconds,
    error: opts.staleError ?? 'stale-reservation',
    limit,
  })

  const orphaned = await findDispatchableDurableJobs(repository, {
    now: nowSeconds,
    createdBefore: nowSeconds - orphanedSeconds,
    limit,
  })

  const dispatchable = uniqueJobs([
    ...stale.slice(0, released),
    ...orphaned,
  ])
  const dispatchResults = await dispatchDurableJobBatch(publisher, dispatchable)

  return {
    released,
    terminalized,
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
