import { jobRegistry } from '#cf-jobs/app'
import { dispatchRegisteredJob } from '#cf-jobs/server'

// Exercises the module's generated registry through the real consumer-side
// runtime inside a built Nuxt (nitropack v2) server. Hit by the `nitro` vitest
// project via @nuxt/test-utils.
export default defineEventHandler(async () => {
  const result = await dispatchRegisteredJob({
    registry: jobRegistry,
    job: {
      id: 'job_1',
      queue: 'default',
      payload: { _task: 'sync/table', siteId: 's1', userId: 1, table: 'widgets' },
      attempts: 1,
      batchId: null,
    },
    createContext: () => ({
      env: {},
      db: undefined,
      log: console,
      jobId: 'job_1',
      batchId: null,
      attempt: 1,
      async release() {},
      async fail() {},
    }),
  })

  return {
    success: result.success,
    registeredJobs: jobRegistry.jobs.map(job => job.name),
  }
})
