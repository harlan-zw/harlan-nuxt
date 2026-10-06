import { defineCheck, pass } from '@harlan-zw/nuxt-checkin/server'

export default defineCheck({ id: 'migration.runtime', run: () => pass({ value: 42 }) })
