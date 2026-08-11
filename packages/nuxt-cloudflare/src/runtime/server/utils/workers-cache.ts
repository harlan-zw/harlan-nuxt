const CACHE_POLICY_HEADER_NAMES = [
  'cache-control',
  'cdn-cache-control',
  'cloudflare-cdn-cache-control',
  'expires',
] as const

const HTML_CACHE_HEADER_NAMES: ReadonlySet<string> = new Set(CACHE_POLICY_HEADER_NAMES.slice(0, 3))

export function hasExplicitCachePolicy(
  getHeader: (name: string) => unknown,
): boolean {
  return CACHE_POLICY_HEADER_NAMES.some(name => Boolean(getHeader(name)))
}

export function withHtmlNoStoreHeaders(
  headers: Record<string, string> = {},
): Record<string, string> {
  const preserved = Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HTML_CACHE_HEADER_NAMES.has(name.toLowerCase())),
  )
  return {
    ...preserved,
    'cache-control': 'private, no-store',
    'cloudflare-cdn-cache-control': 'no-store',
  }
}
