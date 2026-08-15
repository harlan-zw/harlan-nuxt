export default defineNuxtConfig({
  compatibilityDate: '2026-08-13',
  future: {
    compatibilityVersion: 5,
  },
  modules: ['../../../src/module'],
  wideEvents: {
    fields: ['user.id'],
  },
})
