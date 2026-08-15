import { defineNuxtConfig } from 'nuxt/config'
import wideEvents from '../../../src/module'

export default defineNuxtConfig({
  extends: ['../base'],
  modules: [[wideEvents, { console: false }]],
})
