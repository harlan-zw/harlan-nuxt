import type { Check, CheckContext, CheckResult, Collected } from '@harlan-zw/nuxt-checkin/server'
import { defineCheck, pass, unavailable, warn } from '@harlan-zw/nuxt-checkin/server'

export interface SentryCheckOptions {
  id: string
  org: string
  project: string
  environment?: string
  region?: 'us' | 'de'
  /** Omit to include all retained unresolved issues. */
  lookbackDays?: number
  /** Credential name passed to runChecks. Never put the token in Nuxt configuration. */
  credential?: string
  maxPages?: number
}

function parseOptions(options: SentryCheckOptions) {
  if (![options.org, options.project].every(value => typeof value === 'string' && /^[\w-]+$/.test(value)))
    throw new TypeError('Sentry check requires organization and project slugs.')
  if (options.environment !== undefined && !options.environment.trim())
    throw new TypeError('Sentry environment must not be empty.')
  if (options.region !== undefined && options.region !== 'us' && options.region !== 'de')
    throw new TypeError('Sentry region must be us or de.')
  if (options.lookbackDays !== undefined && (!Number.isFinite(options.lookbackDays) || options.lookbackDays <= 0))
    throw new TypeError('Sentry lookback must be positive days.')
  const maxPages = options.maxPages ?? 100
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0)
    throw new TypeError('Sentry page limit must be a positive integer.')
  return { ...options, maxPages }
}

/** Public collection used by module registration and external callers. */
export async function collectSentryIssues(context: CheckContext, input: SentryCheckOptions, request: typeof fetch = fetch): Promise<CheckResult> {
  const options = parseOptions(input)
  const token = context.credentials[options.credential ?? 'sentry']
  if (!token)
    return unavailable('Sentry read credential is unavailable.')
  const since = options.lookbackDays === undefined ? new Date(0).toISOString() : new Date(context.now.getTime() - options.lookbackDays * 86_400_000).toISOString()
  const until = context.now.toISOString()
  const host = options.region ? `${options.region}.sentry.io` : 'sentry.io'
  const endpoint = `https://${host}/api/0/organizations/${options.org}/issues/`
  const key = JSON.stringify(['sentry.issues', options.org, options.project, options.environment, host, since, until, options.credential ?? 'sentry', options.maxPages])
  return context.collect(request, key, async (signal): Promise<Collected<CheckResult>> => {
    let cursor: string | undefined
    let requests = 0
    let bytes = 0
    const ids = new Set<string>()
    const cursors = new Set<string>()
    const finish = (value: CheckResult) => ({ value, metrics: { requests, bytes } })
    const incomplete = (reason: string) => finish(ids.size
      ? { _tag: 'Warn', reason, coverage: 'incomplete', evidence: { project: options.project, issueIds: [...ids].sort(), count: ids.size } }
      : unavailable(reason))
    try {
      for (let page = 0; page < options.maxPages; page++) {
        const url = new URL(endpoint)
        url.searchParams.set('query', 'is:unresolved')
        url.searchParams.set('project', options.project)
        url.searchParams.set('start', since)
        url.searchParams.set('end', until)
        url.searchParams.set('collapse', 'stats')
        url.searchParams.set('limit', '100')
        if (options.environment)
          url.searchParams.set('environment', options.environment)
        if (cursor)
          url.searchParams.set('cursor', cursor)
        const read = () => {
          requests++
          return request(url, { headers: { Authorization: `Bearer ${token}` }, signal, redirect: 'error' })
        }
        let response = await read()
        if (response.status === 429 || response.status >= 500) {
          const header = response.headers.get('retry-after')
          const delay = header === null
            ? 250
            : /^\d+(?:\.\d+)?$/.test(header)
              ? Number(header) * 1000
              : Date.parse(header) - context.now.getTime()
          if (Number.isFinite(delay) && delay >= 0 && delay <= 5000) {
            await response.body?.cancel()
            await retryDelay(delay, signal)
            response = await read()
          }
        }
        if (!response.ok)
          return incomplete(`Sentry query returned HTTP ${response.status}.`)
        const body = await response.text()
        bytes += new TextEncoder().encode(body).byteLength
        const rows: unknown = JSON.parse(body)
        if (!Array.isArray(rows) || rows.some(row => !row || typeof row.id !== 'string' || !/^\d+$/.test(row.id)))
          return incomplete('Sentry query returned invalid issue data.')
        for (const row of rows) {
          if (row.project?.slug !== undefined && row.project.slug !== options.project)
            return incomplete('Sentry query returned a different project.')
          ids.add(row.id)
        }
        const link = response.headers.get('link') ?? ''
        const next = link.split(',').find(part => /rel="next"/.test(part))
        if (!next || /results="false"/.test(next)) {
          const evidence = { project: options.project, environment: options.environment ?? null, since, until, issueIds: [...ids].sort(), count: ids.size }
          return finish(ids.size ? warn('Sentry has unresolved issues.', evidence) : pass(evidence))
        }
        cursor = /cursor="([^"]+)"/.exec(next)?.[1]
        if (!/results="true"/.test(next) || !cursor || cursors.has(cursor))
          return incomplete('Sentry pagination is incomplete.')
        cursors.add(cursor)
      }
    }
    catch {
      // Transport and JSON failures are expected provider failures; retain earlier issue evidence.
      return incomplete('Sentry collection failed before completion.')
    }
    return incomplete('Sentry query exceeded its page limit.')
  })
}

function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Sentry collection was cancelled.'))
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const cancel = () => {
      clearTimeout(timer)
      reject(new Error('Sentry collection was cancelled.'))
    }
    timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel)
      resolve()
    }, ms)
    signal.addEventListener('abort', cancel, { once: true })
  })
}

export function defineSentryCheck(input: SentryCheckOptions, request: typeof fetch = fetch): Check {
  const options = parseOptions(input)
  return defineCheck({ id: options.id, run: context => collectSentryIssues(context, options, request) })
}

export default defineSentryCheck
