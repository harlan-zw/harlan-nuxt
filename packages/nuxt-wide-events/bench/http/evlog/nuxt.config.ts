import evlog from 'evlog/nuxt'
import { defineNuxtConfig } from 'nuxt/config'

export default defineNuxtConfig({
  extends: ['../base'],
  modules: [[evlog, {
    pretty: false,
    silent: true,
  }]],
  ...{ nitro: {
    externals: { inline: ['evlog'] },
  } },
})
