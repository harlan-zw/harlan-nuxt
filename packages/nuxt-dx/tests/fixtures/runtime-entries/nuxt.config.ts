export default defineNuxtConfig({
  compatibilityDate: '2026-08-11',
  future: {
    compatibilityVersion: 5,
  },
  modules: ['../../../src/module', './modules/runtime/module'],
  nuxtDx: {
    report: true,
    sizeBudget: {
      pluginsKb: 0,
      middlewareKb: 0,
      nitroPluginsKb: 0,
      nitroMiddlewareKb: 0,
    },
  },
})
