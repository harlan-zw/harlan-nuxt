import NuxtCfJobs from '../../../src/module'

export default defineNuxtConfig({
  modules: [
    NuxtCfJobs,
  ],
  cfJobs: {
    queues: {
      default: 'QUEUE_DEFAULT',
    },
    jobsDir: 'server/jobs',
    broadcast: true,
    validateWrangler: false,
  },
})
