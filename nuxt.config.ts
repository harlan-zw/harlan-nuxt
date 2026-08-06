import { defineNuxtConfig } from 'nuxt/config'

export default defineNuxtConfig({
  imports: { autoImport: false },

  nitro: {
    imports: { autoImport: false },
  },
})
