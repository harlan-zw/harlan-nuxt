import checks from '#checkin/checks'
import { runChecks } from '@harlan-zw/nuxt-checkin/server'
import { defineEventHandler } from 'nuxt/server'

export default defineEventHandler(() => runChecks(checks))
