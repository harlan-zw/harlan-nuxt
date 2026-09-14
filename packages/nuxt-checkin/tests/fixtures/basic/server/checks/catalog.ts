import { defineCheck, warn } from '@harlan-zw/nuxt-checkin/server'

export default defineCheck({
  id: 'catalog.freshness',
  run: () => warn('Catalog is stale.', { hours: 6 }),
})
