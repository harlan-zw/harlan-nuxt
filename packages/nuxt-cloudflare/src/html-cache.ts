export type HtmlCacheRouteRuleViolation
  = | { _tag: 'html-cache-header', severity: 'error' | 'warning', route: string, configPath: string }
    | { _tag: 'html-cache-route-rule', severity: 'error' | 'warning', route: string, configPath: string }

const NON_HTML_ROUTE_PREFIXES = [
  '/.well-known',
  '/api',
  '/_ipx',
  '/_nuxt',
  '/_og',
  '/assets',
  '/fonts',
  '/images',
  '/mcp',
] as const

const NON_HTML_EXTENSION_RE = /\.(?:avif|css|csv|gif|ico|jpe?g|js|json|map|md|mjs|pdf|png|svg|txt|webmanifest|webp|woff2?|xml)(?:$|[?*])/i
const HTML_CONTENT_TYPE_RE = /^(?:application\/xhtml\+xml|text\/html)(?:\s*;|$)/i
const CACHE_HEADER_NAMES = new Set([
  'cache-control',
  'cdn-cache-control',
  'cloudflare-cdn-cache-control',
])
const CACHE_ROUTE_RULE_NAMES = ['cache', 'isr', 'swr'] as const
const PRIVATE_CACHE_DIRECTIVE_RE = /(?:^|,)\s*(?:no-store|private)\s*(?:,|$)/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function findHeader(headers: Record<string, unknown>, name: string): unknown {
  const entry = Object.entries(headers).find(([header]) => header.toLowerCase() === name)
  return entry?.[1]
}

function hasExplicitNonHtmlContentType(value: Record<string, unknown>): boolean {
  if (!isRecord(value.headers))
    return false
  const contentType = findHeader(value.headers, 'content-type')
  return typeof contentType === 'string' && !HTML_CONTENT_TYPE_RE.test(contentType)
}

function hasHtmlContentType(headers: Record<string, unknown> | undefined): boolean {
  if (!headers)
    return false
  const contentType = findHeader(headers, 'content-type')
  return typeof contentType === 'string' && HTML_CONTENT_TYPE_RE.test(contentType)
}

function isHtmlCapableRoute(route: string, value: Record<string, unknown>): boolean {
  if (NON_HTML_EXTENSION_RE.test(route) || hasExplicitNonHtmlContentType(value))
    return false
  return !NON_HTML_ROUTE_PREFIXES.some(prefix => route === prefix || route.startsWith(`${prefix}/`))
}

function isPrivateCachePolicy(value: unknown): boolean {
  return typeof value === 'string' && PRIVATE_CACHE_DIRECTIVE_RE.test(value)
}

function resolveViolationSeverity(route: string, value: Record<string, unknown>): 'error' | 'warning' {
  const definitelyHtml = value.prerender === true
    || /\.html(?:$|[?*])/i.test(route)
    || hasHtmlContentType(isRecord(value.headers) ? value.headers : undefined)
  return definitelyHtml ? 'error' : 'warning'
}

export function findHtmlCacheRouteRuleViolations(
  routeRules: Record<string, unknown> | undefined,
): HtmlCacheRouteRuleViolation[] {
  if (!routeRules)
    return []

  return Object.entries(routeRules).flatMap(([route, value]) => {
    if (!isRecord(value) || !isHtmlCapableRoute(route, value))
      return []

    const severity = resolveViolationSeverity(route, value)
    const violations: HtmlCacheRouteRuleViolation[] = []
    for (const name of CACHE_ROUTE_RULE_NAMES) {
      if (value[name] !== undefined && value[name] !== false) {
        violations.push({
          _tag: 'html-cache-route-rule',
          severity,
          route,
          configPath: `routeRules.${route}.${name}`,
        })
      }
    }

    if (!isRecord(value.headers))
      return violations

    for (const name of Object.keys(value.headers)) {
      if (CACHE_HEADER_NAMES.has(name.toLowerCase()) && !isPrivateCachePolicy(value.headers[name])) {
        violations.push({
          _tag: 'html-cache-header',
          severity,
          route,
          configPath: `routeRules.${route}.headers.${name}`,
        })
      }
    }
    return violations
  })
}

export function formatHtmlCacheRouteRuleViolations(
  violations: readonly HtmlCacheRouteRuleViolation[],
): string {
  return violations
    .map((violation) => {
      const subject = violation.severity === 'error' ? 'HTML route' : 'Potential HTML route'
      return `${violation.configPath}: ${subject} must remain private and no-store when Workers Cache is enabled.`
    })
    .join('\n')
}
