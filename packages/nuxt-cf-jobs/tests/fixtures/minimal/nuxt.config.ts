import NuxtCfJobs from '../../../src/module'

export default defineNuxtConfig({
  modules: [NuxtCfJobs],
  cfJobs: {
    queues: {},
    reconcile: false,
    validateWrangler: false,
  },
})
