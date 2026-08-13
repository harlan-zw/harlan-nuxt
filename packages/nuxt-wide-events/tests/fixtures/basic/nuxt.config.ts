import process from 'node:process'

const measureSize = process.env.NUXT_WIDE_EVENTS_MEASURE === 'true'

export default defineNuxtConfig({
  compatibilityDate: '2026-08-13',
  future: {
    compatibilityVersion: 5,
  },
  modules: [
    '../../../src/module',
    ...(measureSize ? ['../../../../nuxt-dx/src/module'] : []),
  ],
  wideEvents: {
    console: true,
    fields: ['cache.hit', 'user.id'],
    service: 'integration-fixture',
  },
  ...(measureSize
    ? {
        nuxtDx: {
          report: true,
          sizeBudget: {
            middlewareKb: false,
            nitroMiddlewareKb: false,
            nitroPluginsKb: 0,
            pluginsKb: false,
          },
        },
      }
    : {}),
})
