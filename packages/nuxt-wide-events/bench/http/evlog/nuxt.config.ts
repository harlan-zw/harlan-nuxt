import type { NuxtConfig } from 'nuxt/schema'
import evlog from 'evlog/nuxt'
import { defineNuxtConfig } from 'nuxt/config'

export default defineNuxtConfig({
  extends: ['../base'],
  modules: [[evlog, {
    pretty: false,
    silent: true,
  }]],
  // This benchmark uses Nitro 2. Its options are absent from the fallback builder types.
  nitro: { externals: { inline: ['evlog'] } } as unknown as NuxtConfig['nitro'],
})
