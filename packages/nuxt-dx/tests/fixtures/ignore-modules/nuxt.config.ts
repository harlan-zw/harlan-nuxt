export default defineNuxtConfig({
  compatibilityDate: '2026-08-11',
  future: {
    compatibilityVersion: 5,
  },
  modules: ['../../../src/module', './modules/expensive/module', './modules/enforced/module'],
  nuxtDx: {
    report: true,
    sizeBudget: {
      pluginsKb: false,
      nitroPluginsKb: false,
      modulesKb: 0,
      ignoreModules: ['fixture-expensive-module'],
    },
  },
})
