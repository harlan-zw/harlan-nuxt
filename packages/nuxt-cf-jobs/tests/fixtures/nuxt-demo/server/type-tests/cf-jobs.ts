import type { BroadcastEnvelope, JobBroadcastEnvelope, JobBroadcastMessage, JobDefinitionOf, JobName, JobPayload, JobQueue } from '#cf-jobs/app'
import {
  buildJobPayload,
  getQueue,
  loadJobDefinition,
} from '#cf-jobs/app'
import { defineJob } from '#cf-jobs/server'
import analyticsJob from '../jobs/analytics/rollup-rebuild'
import syncJob from '../jobs/sync/table'

const syncJobName: JobName = 'sync/table'
const analyticsJobName: JobName = 'analytics/rollup-rebuild'

const syncPayload = {
  siteId: 'site_1',
  userId: 123,
  table: 'pages',
  priority: 'low',
} satisfies JobPayload<'sync/table'>

const analyticsPayload = {
  siteId: 'site_1',
  from: '2026-05-01',
  force: true,
} satisfies JobPayload<'analytics/rollup-rebuild'>

const externalJob = defineJob({
  name: 'external/job',
  queue: 'default',
  async handle(_payload: { externalId: string }) {},
})

buildJobPayload(syncJobName, syncPayload)
buildJobPayload(analyticsJobName, analyticsPayload)
getQueue(syncJob).send(syncPayload)
getQueue(analyticsJob).send(analyticsPayload)
getQueue(externalJob).send({ externalId: 'external_1' })

type SyncDefinition = JobDefinitionOf<'sync/table'>
type SyncQueue = JobQueue<'sync/table'>
type SyncBroadcastMessage = JobBroadcastMessage<'sync/table'>
type SyncBroadcastEnvelope = JobBroadcastEnvelope<'sync/table'>

const syncQueue: SyncQueue = 'default'
const lazySyncDefinition: Promise<SyncDefinition | undefined> = loadJobDefinition('sync/table')
const syncBroadcastMessage: SyncBroadcastMessage = {
  channel: 'tenant:site_1',
  event: 'sync.table.updated',
  data: { siteId: 'site_1', table: 'pages', status: 'completed' },
}
const syncBroadcastEnvelope: SyncBroadcastEnvelope = {
  channel: 'tenant:site_1',
  event: 'sync.table.updated',
  data: { siteId: 'site_1', table: 'pages', status: 'failed' },
}
const anyBroadcastEnvelope: BroadcastEnvelope = syncBroadcastEnvelope

void syncQueue
void lazySyncDefinition
void syncBroadcastMessage
void anyBroadcastEnvelope

// @ts-expect-error unknown job names are rejected.
const missingJobName: JobName = 'sync/missing'

// @ts-expect-error sync/table requires userId.
buildJobPayload('sync/table', {
  siteId: 'site_1',
  table: 'pages',
})

buildJobPayload('sync/table', {
  siteId: 'site_1',
  userId: 123,
  table: 'pages',
  // @ts-expect-error sync/table only accepts known priority values.
  priority: 'urgent',
})

buildJobPayload('analytics/rollup-rebuild', {
  siteId: 'site_1',
  from: '2026-05-01',
  // @ts-expect-error analytics/rollup-rebuild payload does not accept table.
  table: 'pages',
})

void missingJobName
