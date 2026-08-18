import type {
  DataCollection,
  MessagePattern,
  ReportPolicy,
  ReportScope,
  SerializedPattern,
  StatusRange,
} from '../runtime/shared/types'
import { BROWSER_EXTENSION_DENY_URLS, BROWSER_NOISE_MESSAGES } from '../runtime/shared/noise'

/**
 * Build time resolution of the Report Policy.
 *
 * Parse, do not validate. Everything a site writes in `nuxt.config.ts` is
 * turned into a serialisable shape once, here, and the runtime trusts it.
 */

export type StatusInput = number | [number, number]

export interface PolicyOptions {
  dropServerStatus?: StatusInput[] | false
  dropClientStatus?: StatusInput[] | false
  dropTransient?: boolean
  ignoreErrors?: Array<string | RegExp>
  /**
   * Messages that never report when the Error Report carries no stack frame.
   *
   * Use it for a failure the browser raises outside site code, where the same
   * message with a stack is still a defect. Default empty.
   */
  dropStacklessErrors?: Array<string | RegExp>
  /**
   * Breadcrumb messages that never report.
   *
   * Use it when the breadcrumb names the cause and the exception does not.
   * Default empty.
   */
  dropBreadcrumbMessages?: Array<string | RegExp>
  denyUrls?: RegExp[]
  browserNoise?: boolean
  secretKeys?: string[]
}

/**
 * Server statuses that never produce an Error Report.
 *
 * 404 only, deliberately narrower than the "all 4xx" three sites use. A 401 or
 * 403 spike is how an auth regression announces itself, and a 429 spike is how
 * a rate limit does. Dropping the whole class hides both. A 404 is the one 4xx
 * that a stale link or a crawler produces in normal operation.
 */
export const DEFAULT_SERVER_DROP_STATUS: readonly StatusInput[] = [404]

/**
 * Client statuses that never produce an Error Report.
 *
 * 401 and 403 are included here and not on the server. In the browser they are
 * an expired session racing a redirect to the login page, which the app already
 * handles. On the server the same status is a real authorisation decision.
 */
export const DEFAULT_CLIENT_DROP_STATUS: readonly StatusInput[] = [401, 403, 404]

export function parseStatusRanges(input: readonly StatusInput[]): StatusRange[] {
  return input.map((entry) => {
    if (typeof entry === 'number') {
      assertStatus(entry)
      return { from: entry, to: entry }
    }
    const [from, to] = entry
    assertStatus(from)
    assertStatus(to)
    if (from > to)
      throw new TypeError(`nuxtSentry status range [${from}, ${to}] must run low to high`)
    return { from, to }
  })
}

function assertStatus(value: number): void {
  if (!Number.isInteger(value) || value < 100 || value > 599)
    throw new TypeError(`nuxtSentry status ${value} must be an integer HTTP status`)
}

export function serializePattern(pattern: RegExp): SerializedPattern {
  // A global pattern keeps `lastIndex` between calls, so a reused instance
  // matches every other report. Strip the flag rather than let that through.
  return { _tag: 'pattern', source: pattern.source, flags: pattern.flags.replace(/[gy]/g, '') }
}

export function parseMessagePatterns(input: ReadonlyArray<string | RegExp>): MessagePattern[] {
  return input.map(entry => typeof entry === 'string'
    ? { _tag: 'literal' as const, value: entry }
    : serializePattern(entry))
}

export interface ResolvePolicyInput {
  scope: ReportScope
  dataCollection: DataCollection
  options: PolicyOptions
}

export function resolveReportPolicy(input: ResolvePolicyInput): ReportPolicy {
  const { options, scope } = input
  const browserNoise = options.browserNoise ?? true
  const configured = scope === 'server' ? options.dropServerStatus : options.dropClientStatus
  const fallback = scope === 'server' ? DEFAULT_SERVER_DROP_STATUS : DEFAULT_CLIENT_DROP_STATUS
  const dropStatus = configured === false
    ? []
    : parseStatusRanges(configured ?? fallback)

  return {
    scope,
    dataCollection: input.dataCollection,
    dropStatus,
    dropTransient: options.dropTransient ?? true,
    ignoreErrors: [
      // Browser noise applies on both scopes. A server rendered page runs the
      // same application code, and a Nitro route can raise the same abort.
      ...(browserNoise ? BROWSER_NOISE_MESSAGES : []),
      ...parseMessagePatterns(options.ignoreErrors ?? []),
    ],
    dropStacklessErrors: parseMessagePatterns(options.dropStacklessErrors ?? []),
    dropBreadcrumbMessages: parseMessagePatterns(options.dropBreadcrumbMessages ?? []),
    denyUrls: [
      ...(browserNoise ? BROWSER_EXTENSION_DENY_URLS : []),
      ...(options.denyUrls ?? []).map(serializePattern),
    ],
    secretKeys: [...(options.secretKeys ?? [])],
  }
}
