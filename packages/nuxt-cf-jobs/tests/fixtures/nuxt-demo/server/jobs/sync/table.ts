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
  broadcast({ payload, status }) {
    return {
      channel: `tenant:${payload.siteId}`,
      event: 'sync.table.updated',
      data: {
        siteId: payload.siteId,
        table: payload.table,
        status,
      },
    } as const
  },
})
