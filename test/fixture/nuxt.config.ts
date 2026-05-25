import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'pathe'

const here = dirname(fileURLToPath(import.meta.url))

export default defineNuxtConfig({
  modules: [resolve(here, '../../src/module.ts')],
  compatibilityDate: '2025-01-01',
})
