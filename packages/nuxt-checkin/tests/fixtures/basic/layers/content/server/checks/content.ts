import { defineCheck, pass } from '@harlan-zw/nuxt-checkin/server'

export default defineCheck({ id: 'content.ready', run: () => pass({ pages: 3 }) })
