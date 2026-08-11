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
      wrangler: { name: 'nuxt-cloudflare-fixture' },
    },
    storage: {
      cache: { driver: 'cloudflare-kv-binding', binding: 'CACHE' },
    },
  },
})
