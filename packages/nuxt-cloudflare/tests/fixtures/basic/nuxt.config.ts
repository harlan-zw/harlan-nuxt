import cloudflareModule from '@harlan-zw/nuxt-cloudflare'
import { defineNuxtConfig } from 'nuxt/config'

export default defineNuxtConfig({
  compatibilityDate: '2026-08-08',
  modules: [[cloudflareModule, {
    requiredSecrets: ['SESSION_PASSWORD'],
    sourceMaps: false,
  }]],
  nitro: {
    cloudflare: {
      wrangler: {
        name: 'nuxt-cloudflare-fixture',
        assets: { run_worker_first: ['/pro/_nuxt/*'] },
        d1_databases: [{ binding: 'DB', database_id: 'fixture-database' }],
        queues: { producers: [{ binding: 'JOBS', queue: 'fixture-jobs' }] },
      },
    },
    storage: {
      cache: { driver: 'cloudflare-kv-binding', binding: 'CACHE' },
    },
  },
})
