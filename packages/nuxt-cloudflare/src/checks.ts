import type { Check } from '@harlan-zw/nuxt-checkin/server'
import { defineCheck, pass, unavailable } from '@harlan-zw/nuxt-checkin/server'
import { resolveCloudflareBindings } from './bindings'

export interface D1CheckOptions {
  id: string
  binding: string
}

export function defineD1Check(options: D1CheckOptions): Check {
  if (!options.binding?.trim())
    throw new TypeError('D1 check requires a binding name.')
  return defineCheck({
    id: options.id,
    async run({ event, collect }) {
      const env = event ? resolveCloudflareBindings<Record<string, unknown>>(event) : undefined
      const db = env?.[options.binding] as { prepare?: (sql: string) => { first: () => Promise<unknown> } } | undefined
      if (typeof db?.prepare !== 'function')
        return unavailable('D1 binding is unavailable.')
      const prepare = db.prepare.bind(db)
      const row = await collect(db, 'cloudflare.d1-read', async () => ({
        value: await prepare('SELECT 1 AS checkin_ready').first(),
        metrics: { requests: 1 },
      }))
      if (!row || typeof row !== 'object' || !('checkin_ready' in row) || row.checkin_ready !== 1)
        return unavailable('D1 read returned an invalid result.')
      return pass({ binding: options.binding, readable: true })
    },
  })
}

export default defineD1Check
