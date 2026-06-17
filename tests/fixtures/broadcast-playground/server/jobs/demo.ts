import { defineJob } from '#cf-jobs/server'

export default defineJob({
  name: 'demo/job',
  queue: 'default',
  async handle(_payload: { jobId: string }) {},
})
