export default defineNuxtConfig({
  compatibilityDate: '2026-08-13',
  modules: ['../../../src/module'],
  nitro: {
    preset: 'cloudflare_module',
  },
  wideEvents: {
    fields: ['worker.ok'],
    service: 'workers-fixture',
  },
})
