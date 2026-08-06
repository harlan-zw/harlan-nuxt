import type { CfJobsApp } from '../server/app'
import type { AnyJobDefinition } from '../server/registry'

/** Names re-exported by the generated `#cf-jobs/app` facade. */
export const cfJobsAppExportNames = [
  'jobRegistry',
  'getHandler',
  'loadJobDefinition',
  'getJobDefinition',
  'getJobQueue',
  'getJobRoute',
  'validateRegistry',
  'validateQueueBindings',
  'assertQueueBindings',
  'getQueue',
  'buildJobPayload',
  'prepareJob',
  'registerQueueConsumer',
  'createDurableRuntime',
] as const satisfies readonly Exclude<keyof CfJobsApp<readonly AnyJobDefinition[]>, 'jobs'>[]
