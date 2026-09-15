import { fileURLToPath } from 'node:url'
import Jobs from '@harlan-zw/nuxt-cf-jobs'
import Cloudflare from '@harlan-zw/nuxt-cloudflare'
import Sentry from '@harlan-zw/nuxt-sentry'
import Checkin from '../../../src/module'

export default defineNuxtConfig({
  modules: [
    [Cloudflare, { enabled: true, bindingTypes: false, checks: [{ id: 'd1.read', binding: 'DB' }] }],
    Checkin,
    [Jobs, { queues: { indexing: 'INDEXING' }, checks: [{ id: 'queue.indexing', d1Binding: 'DB', queue: 'indexing', warnAfterSeconds: 60, failAfterSeconds: 120 }] }],
    [Sentry, { dsn: 'https://public@example.com/1', org: 'example', project: 'site', sourceMaps: false, tasks: false, checks: [{ id: 'sentry.site', org: 'example', project: 'site' }] }],
  ],
  checkin: { external: { required: [], prompts: [{ id: 'fixture.analysis', prompt: 'Explain the collected activity changes.' }] } },
  extends: ['./layers/content'],
  compatibilityDate: '2026-09-01',
  devtools: { enabled: false },
  ssr: true,
  nitro: {
    preset: 'node-server',
    // Linked workspace runtimes need Nitro's virtual imports compiled during development.
    externals: {
      inline: ['nuxt-cf-jobs', 'nuxt-cloudflare', 'nuxt-sentry'].map(name => fileURLToPath(new URL(`../../../../${name}/`, import.meta.url))),
    },
  },
})
