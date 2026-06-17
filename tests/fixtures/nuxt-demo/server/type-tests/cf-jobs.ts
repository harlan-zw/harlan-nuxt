import type { JobDefinitionOf, JobName, JobPayload, JobQueue } from '#cf-jobs/app'
import {
  buildJobPayload,
  loadJobDefinition,
} from '#cf-jobs/app'

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

buildJobPayload(syncJobName, syncPayload)
buildJobPayload(analyticsJobName, analyticsPayload)

type SyncDefinition = JobDefinitionOf<'sync/table'>
type SyncQueue = JobQueue<'sync/table'>

const syncQueue: SyncQueue = 'default'
const lazySyncDefinition: Promise<SyncDefinition | undefined> = loadJobDefinition('sync/table')

void syncQueue
void lazySyncDefinition

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
