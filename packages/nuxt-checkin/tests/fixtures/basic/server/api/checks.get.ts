import { runChecks } from '@harlan-zw/nuxt-checkin/server'
import checks from '#checkin/checks'

export default defineEventHandler((event) => {
  event.context.cloudflare = { env: { DB: { prepare: () => ({
    first: async () => ({ checkin_ready: 1 }),
    all: async () => ({ success: true, results: [] }),
  }) } } }
  return runChecks(checks, { event, identity: { site: 'fixture', environment: 'test', deployment: 'fixture-v1' }, required: ['catalog.freshness', 'content.ready', 'd1.read', 'queue.indexing', 'sentry.site'], totalTimeoutMs: 5000 })
})
