import Jobs from '../../../../nuxt-cf-jobs/src/module'
import Cloudflare from '../../../../nuxt-cloudflare/src/module'
import Sentry from '../../../../nuxt-sentry/src/module'
import Checkin from '../../../src/module'

export default defineNuxtConfig({
  modules: [
    [Cloudflare, { enabled: true, bindingTypes: false, checks: [{ id: 'd1.read', binding: 'DB' }] }],
    Checkin,
    [Jobs, { queues: { indexing: 'INDEXING' }, checks: [{ id: 'queue.indexing', d1Binding: 'DB', queue: 'indexing', warnAfterSeconds: 60, failAfterSeconds: 120 }] }],
    [Sentry, { dsn: 'https://public@example.com/1', org: 'example', project: 'site', sourceMaps: false, tasks: false, checks: [{ id: 'sentry.site', org: 'example', project: 'site' }] }],
  ],
  extends: ['./layers/content'],
  compatibilityDate: '2026-09-01',
  devtools: { enabled: false },
  ssr: true,
  nitro: { preset: 'node-server' },
})
