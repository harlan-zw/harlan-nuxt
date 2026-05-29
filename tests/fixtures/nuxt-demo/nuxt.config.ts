import NuxtCfJobs from '../../../src/module'

export default defineNuxtConfig({
  modules: [
    NuxtCfJobs,
  ],
  cfJobs: {
    queues: {
      default: 'QUEUE_DEFAULT',
      analytics: 'QUEUE_ANALYTICS',
    },
    jobsDir: 'server/jobs',
    tasksDir: 'server/tasks',
  },
})
