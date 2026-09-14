import { runChecks } from '@harlan-zw/nuxt-checkin/server'
import checks from '#checkin/checks'

export default defineEventHandler((event) => {
  event.context.cloudflare = { env: { DB: { prepare: () => ({
    first: async () => ({ checkin_ready: 1 }),
    all: async () => ({ success: true, results: [] }),
  }) } } }
  return runChecks(checks, { event })
})
