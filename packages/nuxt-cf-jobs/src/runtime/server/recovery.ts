import type {
  DispatchDurableJobBatchResult,
  DurableJobPublicationRepository,
  DurableJobRecord,
  DurableJobRecoveryRepository,
  DurableJobTerminalized,
  QueuePublisher,
} from './outbox'
import {
  dispatchDurableJobBatch,
  failStaleReservedDurableJobs,
  findDispatchableDurableJobs,
  publishDurableJobBatch,
  releaseStaleReservedDurableJobs,
} from './outbox'

export interface RecoverDurableJobsOptions {
  now?: number
  /** Reserved rows older than this are released. Defaults to 900s. */
  staleSeconds?: number
  /** Due, unreserved rows older than this are treated as orphaned. Defaults to 6h. */
  orphanedSeconds?: number
  /** Let the original CF message reclaim a reaped row before dispatching a duplicate. Defaults to 120s. */
  redeliveryGraceSeconds?: number
  /**
   * Minimum gap between two orphan re-dispatches of the SAME row. Defaults to
   * `orphanedSeconds`, i.e. a row is re-sent at most once per orphan window.
   * This is what bounds the sweep's write rate to the rate rows age past the
   * window, rather than to `limit x ticks-per-hour`.
   */
  redispatchGraceSeconds?: number
  limit?: number
  staleError?: string
  /** Settle batches or publish telemetry for rows terminalized by the stale reaper. */
  onTerminalized?: (jobs: DurableJobTerminalized[]) => void | Promise<void>
}

export interface RecoverDurableJobsResult<Queue extends string = string> {
  released: number
  terminalized: number
  terminalizedJobs: DurableJobTerminalized<Queue>[]
  swept: number
  dispatched: number
  /**
   * Rows stamped as re-dispatched this tick, so they are excluded from the next
   * sweep's window. Read it beside `swept`: a `swept` that stays high while this
   * stays 0 means the repository has no `noteOrphanRedispatch` and the sweep is
   * running memoryless.
   */
  redispatchNoted: number
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
  const staleSeconds = opts.staleSeconds ?? 900
  const orphanedSeconds = opts.orphanedSeconds ?? 6 * 60 * 60
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

  // The sweep must not re-send a row it already re-sent this window. Age alone
  // cannot express that: `createdBefore` is true of every row queued behind a
  // backlog, so without this the sweep re-selects the same oldest `limit` rows
  // every tick (oldest candidates first) and becomes a producer instead
  // of a repair. See `DurableJobRecoveryQuery.redispatchedBefore`.
  const redispatchGraceSeconds = Math.max(0, opts.redispatchGraceSeconds ?? orphanedSeconds)
  const orphaned = await findDispatchableDurableJobs(repository, {
    now: nowSeconds,
    createdBefore: nowSeconds - orphanedSeconds,
    ...(redeliveryGraceSeconds > 0 ? { staleReleasedBefore: nowSeconds - redeliveryGraceSeconds } : {}),
    ...(redispatchGraceSeconds > 0 ? { redispatchedBefore: nowSeconds - redispatchGraceSeconds } : {}),
    publication: 'all',
    limit,
  })

  const releasedIds = new Set(stale.slice(0, released).map(job => job.id))
  const dispatchable = uniqueJobs(redeliveryGraceSeconds > 0
    ? orphaned.filter(job => !releasedIds.has(job.id))
    : [...stale.slice(0, released), ...orphaned])
  const publicationRepository = repository as DurableJobRecoveryRepository<Queue, Record> & Partial<DurableJobPublicationRepository>
  const dispatchResults: Array<DispatchDurableJobBatchResult<Queue>> = publicationRepository.markJobsPublished && publicationRepository.noteJobsDispatchFailure
    ? (await publishDurableJobBatch(
        publicationRepository as DurableJobRecoveryRepository<Queue, Record> & DurableJobPublicationRepository,
        publisher,
        dispatchable,
        { now: nowSeconds },
      )).map((result): DispatchDurableJobBatchResult<Queue> => {
        if (result.status === 'published')
          return { queue: result.queue, status: 'sent' }
        if (result.status === 'not-dispatched')
          return { queue: result.queue, status: 'not-dispatched' }
        return { queue: result.queue, status: 'failed', cause: result.cause }
      })
    : await dispatchDurableJobBatch(publisher, dispatchable)

  // Stamp AFTER dispatch, and only the rows the sweep actually re-sent, so a
  // failed send stays eligible for the next tick. A repository without the
  // method degrades to the previous memoryless behaviour rather than throwing.
  const sentQueues = new Set(dispatchResults.filter(result => result.status === 'sent').map(result => result.queue))
  const redispatchedIds = dispatchable.filter(job => sentQueues.has(job.queue)).map(job => job.id)
  const redispatchNoted = redispatchedIds.length > 0
    ? await repository.noteOrphanRedispatch?.(redispatchedIds, { at: nowSeconds }) ?? 0
    : 0

  return {
    redispatchNoted,
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
