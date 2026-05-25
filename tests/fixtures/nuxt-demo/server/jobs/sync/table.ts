import { defineJob } from '#cf-jobs/server'

export default defineJob({
  name: 'sync/table',
  queue: 'default',
  async handle(_payload: {
    siteId: string
    userId: number
    table: string
    priority?: 'low' | 'normal'
  }) {},
})
