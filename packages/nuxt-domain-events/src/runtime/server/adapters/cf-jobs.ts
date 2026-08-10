import type {
  EventCommitInput,
  EventQueueAdapter,
  QueueAdapterCallContext,
  QueuedListenerPublication,
  QueuePublicationOutcome,
} from '../types'

interface Result<Output, Error> {
  ok: boolean
  value?: Output
  error?: Error
}

export interface CfJobsDurableRecord<Queue extends string = string> {
  id: string
  queue: Queue
  jobType: string
  traceId: string
  payload: string
  attempts: number
  maxAttempts: number
  backoff?: number[]
  availableAt: number
  createdAt: number
}

export interface CfJobsPreparedStage<Record, Statement> {
  records: readonly Record[]
  statements: Statement[]
}

export interface CfJobsOutboxPrimitives<JobRecord extends CfJobsDurableRecord, Repository, Publisher> {
  prepareDurableJobResult: (options: {
    name: 'events/deliver-listener'
    payload: Record<string, unknown>
    route: { queue: string, jobType: string }
    id: string
    traceId: string
    defaultMaxAttempts: number
    backoff?: number[]
  }) => Promise<Result<JobRecord, unknown>>
  stagePreparedDurableJobs: (
    repository: Repository,
    records: readonly JobRecord[],
  ) => Promise<
    | { status: 'staged', records: readonly JobRecord[] }
    | { status: 'invalid' | 'unsupported' | 'failed', error?: unknown, reason?: string, cause?: unknown }
  >
  publishDurableJobBatch: (
    repository: Repository,
    publisher: Publisher,
    records: readonly Pick<JobRecord, 'id' | 'queue'>[],
  ) => Promise<Array<{
    queue: string
    status: 'published' | 'not-dispatched' | 'failed' | 'state-failed'
    jobIds: string[]
    cause?: unknown
  }>>
}

export interface CfJobsEventQueueAdapterOptions<
  JobRecord extends CfJobsDurableRecord,
  Repository extends { prepareStageJobs: (records: readonly JobRecord[]) => Result<CfJobsPreparedStage<JobRecord, Statement>, unknown> },
  Publisher,
  Statement,
> {
  outbox: CfJobsOutboxPrimitives<JobRecord, Repository, Publisher>
  repository: Repository
  publisher: Publisher
}

export interface CfJobsEventQueueAdapter<JobRecord extends CfJobsDurableRecord, Statement> {
  queue: EventQueueAdapter
  /**
   * Prepare unpublished D1 statements for a caller-owned atomic transaction.
   * The caller batches these with domain statements and returns `committed` only
   * after D1 resolves. Rollback must discard all statements.
   */
  prepareCommitStage: (input: EventCommitInput) => Promise<{
    records: readonly JobRecord[]
    statements: Statement[]
    receipt: {
      _tag: 'staged-event-listeners'
      deliveryIds: readonly string[]
    }
  }>
}

/**
 * One-way adapter over the public `nuxt-cf-jobs/outbox` functions. Pass that
 * module as `outbox`; the event core itself imports no Cloudflare or jobs code.
 */
export function createCfJobsEventQueueAdapter<
  JobRecord extends CfJobsDurableRecord,
  Repository extends { prepareStageJobs: (records: readonly JobRecord[]) => Result<CfJobsPreparedStage<JobRecord, Statement>, unknown> },
  Publisher,
  Statement,
>(options: CfJobsEventQueueAdapterOptions<JobRecord, Repository, Publisher, Statement>): CfJobsEventQueueAdapter<JobRecord, Statement> {
  const prepare = async (publications: readonly QueuedListenerPublication[]): Promise<JobRecord[]> => {
    return await Promise.all(publications.map(async (publication) => {
      const result = await options.outbox.prepareDurableJobResult({
        name: 'events/deliver-listener',
        payload: publication.envelope as unknown as Record<string, unknown>,
        route: {
          queue: publication.queue,
          jobType: `event-listener/${publication.envelope.listenerName}`,
        },
        id: publication.deliveryId,
        traceId: publication.envelope.eventId,
        defaultMaxAttempts: publication.tries ?? 3,
        ...(publication.backoff === undefined ? {} : { backoff: [...publication.backoff] }),
      })
      if (!result.ok || !result.value)
        throw adapterError('prepare-failed', 'Failed to prepare an event listener durable job', result.error)
      return result.value
    }))
  }

  const publish = async (
    records: readonly Pick<JobRecord, 'id' | 'queue'>[],
    publications: readonly QueuedListenerPublication[],
    _context: QueueAdapterCallContext,
  ): Promise<readonly QueuePublicationOutcome[]> => {
    const results = await options.outbox.publishDurableJobBatch(options.repository, options.publisher, records)
    const byDeliveryId = new Map(results.flatMap(result => result.jobIds.map(id => [id, result] as const)))
    return publications.map((publication): QueuePublicationOutcome => {
      const result = byDeliveryId.get(publication.deliveryId)
      if (!result || result.queue !== publication.queue) {
        return {
          _tag: 'failed',
          deliveryId: publication.deliveryId,
          queue: publication.queue,
          status: 'adapter-failed',
          error: adapterError('publish-failed', `nuxt-cf-jobs omitted publication outcome for ${publication.deliveryId}`),
        }
      }
      if (result.status === 'published')
        return { _tag: 'published', deliveryId: publication.deliveryId, queue: publication.queue }
      return {
        _tag: 'failed',
        deliveryId: publication.deliveryId,
        queue: publication.queue,
        status: result.status,
        error: result.cause ?? adapterError('publish-failed', `nuxt-cf-jobs returned ${result.status} for ${publication.deliveryId}`),
      }
    })
  }

  return {
    queue: {
      publishImmediate: async (publications, context) => {
        const records = await prepare(publications)
        const staged = await options.outbox.stagePreparedDurableJobs(options.repository, records)
        if (staged.status !== 'staged')
          throw adapterError('stage-failed', 'Failed to durably stage event listener jobs', staged)
        return await publish(records, publications, context)
      },
      dispatchCommitted: async (publications, context) => {
        const records = publications.map(publication => ({ id: publication.deliveryId, queue: publication.queue })) as Array<Pick<JobRecord, 'id' | 'queue'>>
        return await publish(records, publications, context)
      },
    },
    prepareCommitStage: async (input) => {
      const records = await prepare(input.publications)
      const prepared = options.repository.prepareStageJobs(records)
      if (!prepared.ok || !prepared.value)
        throw adapterError('prepare-stage-failed', 'Failed to prepare event listener D1 statements', prepared.error)
      const stagedDeliveryIds = prepared.value.records.map(record => record.id)
      if (!sameDeliveryIds(input.publications.map(publication => publication.deliveryId), stagedDeliveryIds))
        throw adapterError('prepare-stage-failed', 'Prepared D1 statements do not match requested listener deliveries')
      return {
        records: prepared.value.records,
        statements: prepared.value.statements,
        receipt: Object.freeze({
          _tag: 'staged-event-listeners' as const,
          deliveryIds: Object.freeze(stagedDeliveryIds),
        }),
      }
    },
  }
}

function sameDeliveryIds(expected: readonly string[], actual: readonly string[]): boolean {
  if (expected.length !== actual.length || new Set(actual).size !== actual.length)
    return false
  const actualIds = new Set(actual)
  return expected.every(id => actualIds.has(id))
}

type CfJobsEventAdapterError = Error & {
  _tag: 'CfJobsEventAdapterError'
  stage: 'prepare-failed' | 'stage-failed' | 'publish-failed' | 'prepare-stage-failed'
  cause?: unknown
}

function adapterError(stage: CfJobsEventAdapterError['stage'], message: string, cause?: unknown): CfJobsEventAdapterError {
  return Object.assign(new Error(message), {
    _tag: 'CfJobsEventAdapterError' as const,
    stage,
    ...(cause === undefined ? {} : { cause }),
  })
}
