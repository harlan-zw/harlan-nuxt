import type { Check } from '@harlan-zw/nuxt-checkin/server'
import { defineCheck, pass, unavailable, warn } from '@harlan-zw/nuxt-checkin/server'

export interface SentryCheckOptions {
  id: string
  org: string
  project: string
  /** Credential name passed to runChecks. Never put the token in Nuxt configuration. */
  credential?: string
  maxPages?: number
}

export function defineSentryCheck(options: SentryCheckOptions, request: typeof fetch = fetch): Check {
  if (![options.org, options.project].every(value => typeof value === 'string' && /^[\w-]+$/.test(value)))
    throw new TypeError('Sentry check requires organization and project slugs.')
  const maxPages = options.maxPages ?? 10
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0)
    throw new TypeError('Sentry page limit must be a positive integer.')
  return defineCheck({
    id: options.id,
    async run({ credentials, signal, now }) {
      const token = credentials[options.credential ?? 'sentry']
      if (!token)
        return unavailable('Sentry read credential is unavailable.')
      const since = new Date(now.getTime() - 14 * 86_400_000).toISOString()
      const until = now.toISOString()
      const endpoint = `https://sentry.io/api/0/projects/${options.org}/${options.project}/issues/`
      let cursor: string | undefined
      const ids = new Set<string>()
      const cursors = new Set<string>()
      for (let page = 0; page < maxPages; page++) {
        const url = new URL(endpoint)
        url.searchParams.set('query', `is:unresolved lastSeen:>=${since} lastSeen:<=${until}`)
        url.searchParams.set('statsPeriod', '14d')
        url.searchParams.set('per_page', '100')
        if (cursor)
          url.searchParams.set('cursor', cursor)
        const response = await request(url, { headers: { Authorization: `Bearer ${token}` }, signal, redirect: 'error' })
        if (!response.ok)
          return unavailable(`Sentry query returned HTTP ${response.status}.`)
        const rows: unknown = await response.json()
        if (!Array.isArray(rows) || rows.some(row => !row || typeof row.id !== 'string' || !/^\d+$/.test(row.id)))
          return unavailable('Sentry query returned invalid issue data.')
        for (const row of rows)
          ids.add(row.id)
        const link = response.headers.get('link') ?? ''
        const next = link.split(',').find(part => /rel="next"/.test(part))
        if (!next || /results="false"/.test(next)) {
          const evidence = { project: options.project, since, until, issueIds: [...ids].sort(), count: ids.size }
          return ids.size ? warn('Sentry has unresolved issues in the last 14 days.', evidence) : pass(evidence)
        }
        cursor = /cursor="([^"]+)"/.exec(next)?.[1]
        if (!/results="true"/.test(next) || !cursor || cursors.has(cursor))
          return unavailable('Sentry pagination is incomplete.')
        cursors.add(cursor)
      }
      return unavailable('Sentry query exceeded its page limit.')
    },
  })
}

export default defineSentryCheck
