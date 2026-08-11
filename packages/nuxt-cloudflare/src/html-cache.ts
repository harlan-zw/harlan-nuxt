export type HtmlCacheRouteRuleViolation
  = | { _tag: 'html-cache-header', route: string, configPath: string }
    | { _tag: 'html-cache-route-rule', route: string, configPath: string }

const NON_HTML_ROUTE_PREFIXES = [
  '/api',
  '/_ipx',
  '/_nuxt',
  '/assets',
  '/fonts',
  '/images',
] as const

const NON_HTML_EXTENSION_RE = /\.(?:avif|css|csv|gif|ico|jpe?g|js|json|map|md|mjs|pdf|png|svg|txt|webmanifest|webp|woff2?|xml)(?:$|[?*])/i
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

function isHtmlCapableRoute(route: string): boolean {
  if (NON_HTML_EXTENSION_RE.test(route))
    return false
  return !NON_HTML_ROUTE_PREFIXES.some(prefix => route === prefix || route.startsWith(`${prefix}/`))
}

function isPrivateCachePolicy(value: unknown): boolean {
  return typeof value === 'string' && PRIVATE_CACHE_DIRECTIVE_RE.test(value)
}

export function findHtmlCacheRouteRuleViolations(
  routeRules: Record<string, unknown> | undefined,
): HtmlCacheRouteRuleViolation[] {
  if (!routeRules)
    return []

  return Object.entries(routeRules).flatMap(([route, value]) => {
    if (!isHtmlCapableRoute(route) || !isRecord(value))
      return []

    const violations: HtmlCacheRouteRuleViolation[] = []
    for (const name of CACHE_ROUTE_RULE_NAMES) {
      if (value[name] !== undefined && value[name] !== false) {
        violations.push({
          _tag: 'html-cache-route-rule',
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
    .map(violation => `${violation.configPath}: Workers Caching requires HTML responses to remain private and no-store.`)
    .join('\n')
}
