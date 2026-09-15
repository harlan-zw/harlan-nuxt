export default defineNuxtConfig({
  compatibilityDate: '2026-09-15',
  modules: ['../../../src/module'],
  nuxtDx: { sizeBudget: false, payloadUsage: { prerender: true } },
  nitro: { prerender: { routes: ['/', '/other'] } },
})
