import type {
  ErrorReport,
  MessagePattern,
  ReportDecision,
  ReportPolicy,
  SerializedPattern,
  StatusRange,
} from './types'

/**
 * Drop Rules. Every function here is pure: it reads an Error Report and an
 * error, and returns a decision. Nothing calls Sentry.
 */

/** A cyclic `cause` chain must not loop, and a deep one is never informative. */
const MAX_CAUSE_DEPTH = 8

interface ErrorLike {
  name?: unknown
  message?: unknown
  statusCode?: unknown
  status?: unknown
  data?: unknown
  response?: unknown
  cause?: unknown
}

/**
 * Every link of an error's `cause` chain, the error itself first.
 *
 * A Nitro handler wraps an upstream failure, so the status that decides the
 * Drop Rule is often two links down. Reading only the outer error is the bug
 * `mdream.dev` and `unlighthouse.dev` each worked around by message matching.
 */
export function errorChain(error: unknown): ErrorLike[] {
  const chain: ErrorLike[] = []
  const seen = new Set<object>()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current) && chain.length < MAX_CAUSE_DEPTH) {
    seen.add(current)
    const link = current as ErrorLike
    chain.push(link)
    current = link.cause
  }
  return chain
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * The HTTP status an error carries, across every shape these sites produce:
 * `statusCode` on an H3Error, `status` on a fetch failure, `data.statusCode` on
 * a NuxtError serialised across the SSR boundary, and `response.status` on an
 * ofetch error.
 */
export function errorStatusCode(error: unknown): number | undefined {
  for (const link of errorChain(error)) {
    const data = link.data as { statusCode?: unknown } | null | undefined
    const response = link.response as { status?: unknown } | null | undefined
    const status = numberOrUndefined(link.statusCode)
      ?? numberOrUndefined(link.status)
      ?? numberOrUndefined(data?.statusCode)
      ?? numberOrUndefined(response?.status)
    if (status !== undefined)
      return status
  }
  return undefined
}

export function matchesStatus(status: number | undefined, ranges: readonly StatusRange[]): boolean {
  if (status === undefined)
    return false
  return ranges.some(range => status >= range.from && status <= range.to)
}

const TRANSIENT_NAMES = new Set(['TimeoutError', 'AbortError'])
const TRANSIENT_MESSAGE = /aborted due to timeout|operation was aborted|the user aborted a request|signal is aborted without reason|<no response>/i

/**
 * A transient upstream or network failure.
 *
 * The remote host was slow, unreachable, or the request was cancelled by a
 * navigation. None of those is a defect in the site, and every one of them
 * arrives in volume during an outage, which is exactly when the error quota
 * matters most.
 */
export function isTransientError(error: unknown): boolean {
  const chain = errorChain(error)
  if (chain.some(link => typeof link.name === 'string' && TRANSIENT_NAMES.has(link.name)))
    return true
  return chain.some(link => typeof link.message === 'string' && TRANSIENT_MESSAGE.test(link.message))
}

/** Rebuild a serialised pattern. Called once per plugin start, not per report. */
export function compilePattern(pattern: SerializedPattern): RegExp {
  return new RegExp(pattern.source, pattern.flags)
}

export function matchesMessage(text: string, patterns: readonly MessagePattern[]): boolean {
  return patterns.some(pattern => pattern._tag === 'literal'
    ? text.includes(pattern.value)
    : compilePattern(pattern).test(text))
}

/** Every free text field of a report that an ignore pattern is matched against. */
export function reportMessages(report: ErrorReport, error: unknown): string[] {
  const texts: string[] = []
  if (typeof report.message === 'string')
    texts.push(report.message)
  for (const value of report.exception?.values ?? []) {
    if (typeof value.type === 'string' && typeof value.value === 'string')
      texts.push(`${value.type}: ${value.value}`)
    else if (typeof value.value === 'string')
      texts.push(value.value)
    else if (typeof value.type === 'string')
      texts.push(value.type)
  }
  for (const link of errorChain(error)) {
    if (typeof link.name === 'string' && typeof link.message === 'string')
      texts.push(`${link.name}: ${link.message}`)
    else if (typeof link.message === 'string')
      texts.push(link.message)
  }
  return texts
}

/**
 * Every stack frame the report carries, across every exception value.
 *
 * A report with none of them names no site code. `unlighthouse.dev` lost a
 * manifest fetch failure that arrives this way: the browser rejects the fetch
 * on the global handler, so the report is one `TypeError: Failed to fetch` with
 * an empty frame list.
 */
export function reportFrameCount(report: ErrorReport): number {
  let count = 0
  for (const value of report.exception?.values ?? [])
    count += value.stacktrace?.frames?.length ?? 0
  return count
}

/**
 * Every breadcrumb message a breadcrumb rule is matched against.
 *
 * The breadcrumb often names the cause the exception does not. `nuxtseo.com`
 * lost its stale chunk filter this way: the thrown error names a component, and
 * only the console breadcrumb says the chunk was gone.
 */
export function reportBreadcrumbMessages(report: ErrorReport): string[] {
  const messages: string[] = []
  for (const breadcrumb of report.breadcrumbs ?? []) {
    if (typeof breadcrumb.message === 'string')
      messages.push(breadcrumb.message)
  }
  return messages
}

/** Every stack frame file name a deny rule is matched against. */
export function reportSourceUrls(report: ErrorReport): string[] {
  const urls: string[] = []
  for (const value of report.exception?.values ?? []) {
    for (const frame of value.stacktrace?.frames ?? []) {
      if (typeof frame.filename === 'string')
        urls.push(frame.filename)
    }
  }
  return urls
}

/**
 * Run every Drop Rule in order and say which one fired.
 *
 * The rule name is part of the result rather than a boolean, so a site can log
 * why a report never arrived. Silently returning `null` from `beforeSend` is
 * what made the estate's existing filters impossible to debug.
 */
export function decideReport(report: ErrorReport, error: unknown, policy: ReportPolicy): ReportDecision {
  if (matchesStatus(errorStatusCode(error), policy.dropStatus))
    return { _tag: 'drop', rule: 'status' }

  if (policy.dropTransient && isTransientError(error))
    return { _tag: 'drop', rule: 'transient' }

  if (policy.ignoreErrors.length > 0) {
    const texts = reportMessages(report, error)
    if (texts.some(text => matchesMessage(text, policy.ignoreErrors)))
      return { _tag: 'drop', rule: 'ignore-message' }
  }

  if (policy.dropStacklessErrors.length > 0 && reportFrameCount(report) === 0) {
    const texts = reportMessages(report, error)
    if (texts.some(text => matchesMessage(text, policy.dropStacklessErrors)))
      return { _tag: 'drop', rule: 'stackless-message' }
  }

  if (policy.dropBreadcrumbMessages.length > 0) {
    const messages = reportBreadcrumbMessages(report)
    if (messages.some(text => matchesMessage(text, policy.dropBreadcrumbMessages)))
      return { _tag: 'drop', rule: 'breadcrumb-message' }
  }

  if (policy.denyUrls.length > 0) {
    const patterns = policy.denyUrls.map(compilePattern)
    const urls = reportSourceUrls(report)
    if (urls.length > 0 && urls.every(url => patterns.some(pattern => pattern.test(url))))
      return { _tag: 'drop', rule: 'deny-url' }
  }

  return { _tag: 'send' }
}
