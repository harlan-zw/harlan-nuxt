import process from 'node:process'

const measureSize = process.env.NUXT_WIDE_EVENTS_MEASURE === 'true'
const testPolicy = process.env.NUXT_WIDE_EVENTS_POLICY === 'true'
const standaloneOnly = process.env.NUXT_WIDE_EVENTS_STANDALONE === 'true'

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
    request: !standaloneOnly,
    service: 'integration-fixture',
    ...(testPolicy
      ? {
          exclude: ['/api/excluded/**'],
          sampling: {
            rates: { debug: 0, error: 0, info: 0, warn: 50 },
            keep: [{ duration: 1000 }, { status: 400 }],
          },
        }
      : {}),
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
