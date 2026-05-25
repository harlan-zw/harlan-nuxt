import { defineJob } from '#cf-jobs/server'

export default defineJob({
  name: 'analytics/rollup-rebuild',
  queue: 'analytics',
  async handle(_payload: {
    siteId: string
    from: string
    force?: boolean
  }) {},
})
