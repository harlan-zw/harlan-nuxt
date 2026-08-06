import { defineNuxtConfig } from 'nuxt/config'

export default defineNuxtConfig({
  components: {
    dirs: [
      { path: '~/components/global', global: true },
      '~/components',
    ],
    transform: {
      exclude: [/\.vue(?:$|\?)/, /\.[jt]sx(?:$|\?)/],
    },
  },
  imports: { autoImport: false },

  nitro: {
    imports: { autoImport: false },
  },
})
