export const DEFAULT_FAST_404_EDGE_CACHE_TTL_SECONDS = 300

export const DEFAULT_FAST_404_ALLOW_PREFIXES = [
  '/_nuxt/',
  '/_og/',
  '/_og-static-fonts/',
  '/__og-image__/',
  '/_ipx/',
  '/_fonts/',
  '/_scripts/',
  '/api/',
  '/auth/',
  '/__nuxt_error',
  '/__nuxt_island/',
  '/__nuxt_content/',
  '/__comark_content/',
  '/__ai-ready/',
  '/__sitemap__/',
  '/__link-checker__/',
  '/__skew/',
  '/.well-known/agent-skills',
  '/@vite/',
  '/@fs/',
  '/@id/',
  '/__vite_ping',
  '/__nuxt_devtools__/',
] as const

export interface Fast404Options {
  /**
   * Extra pathname prefixes that bypass fast-404 matching.
   * Merged with `DEFAULT_FAST_404_ALLOW_PREFIXES`.
   */
  allowPrefixes?: readonly string[]
  /**
   * Edge cache TTL in seconds written to `Cloudflare-CDN-Cache-Control`.
   * Defaults to `300`. Set `0` to emit `no-store`.
   */
  edgeCacheTtlSeconds?: number
}

export type Fast404Policy
  = | { _tag: 'disabled' }
    | {
      _tag: 'enabled'
      allowPrefixes: readonly string[]
      edgeCacheTtlSeconds: number
    }

export type Fast404Reason
  = | 'dotfile'
    | 'cms-or-scanner'
    | 'script-extension'
    | 'static-extension'

export type Fast404Decision
  = | { _tag: 'pass' }
    | { _tag: 'not-found', reason: Fast404Reason }

export interface Fast404RuntimeConfig {
  allowPrefixes?: readonly string[]
  edgeCacheTtlSeconds?: number
}

const EXACT_ALLOW_PATTERNS = [
  /^\/robots\.txt$/i,
  /^\/sitemap[^/]*\.xml$/i,
  /^\/llms[^/]*\.txt$/i,
] as const

const SAFE_SUFFIX_PATTERNS = [
  /\.md$/i,
  /(?:^|\/)_payload\.json$/i,
  /(?:^|\/)_payload\.js$/i,
] as const

const CMS_SCANNER_PREFIXES = [
  '/wp-admin',
  '/wp-content',
  '/wp-includes',
  '/wp-json',
  '/wp-login.php',
  '/wp-config.php',
  '/wordpress',
  '/xmlrpc.php',
  '/phpmyadmin',
  '/pma',
  '/myadmin',
  '/adminer',
  '/adminer.php',
  '/cgi-bin',
  '/vendor/phpunit',
  '/boaform',
  '/actuator',
  '/solr',
  '/jmx-console',
  '/autodiscover',
  '/owa',
  '/ecp',
  '/wlwmanifest.xml',
  '/manager/html',
  '/hudson',
  '/jenkins',
] as const

const SCRIPT_EXTENSIONS = new Set([
  '.php',
  '.phtml',
  '.phar',
  '.asp',
  '.aspx',
  '.ashx',
  '.asmx',
  '.jsp',
  '.jspx',
  '.cgi',
  '.pl',
  '.py',
  '.rb',
  '.sh',
  '.bat',
  '.exe',
  '.dll',
  '.sql',
  '.bak',
  '.old',
  '.orig',
  '.swp',
  '.swo',
  '.save',
  '.dist',
  '.inc',
  '.env',
  '.ini',
  '.log',
  '.cfg',
  '.conf',
])

const STATIC_ASSET_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.svg',
  '.bmp',
  '.tif',
  '.tiff',
  '.mp4',
  '.webm',
  '.mp3',
  '.wav',
  '.ogg',
  '.mov',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.map',
  '.wasm',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.rar',
  '.7z',
  '.bz2',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.xml',
  '.txt',
  '.json',
  '.webmanifest',
  '.yaml',
  '.yml',
  '.toml',
  '.csv',
])

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim()
  if (!trimmed)
    return ''
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

export function resolveFast404Policy(input: boolean | Fast404Options | undefined): Fast404Policy {
  if (!input)
    return { _tag: 'disabled' }

  if (input === true) {
    return {
      _tag: 'enabled',
      allowPrefixes: [],
      edgeCacheTtlSeconds: DEFAULT_FAST_404_EDGE_CACHE_TTL_SECONDS,
    }
  }

  const ttl = input.edgeCacheTtlSeconds ?? DEFAULT_FAST_404_EDGE_CACHE_TTL_SECONDS
  if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl < 0) {
    throw new Error(
      `[nuxt-cloudflare] fast404.edgeCacheTtlSeconds must be zero or a positive number, received ${String(ttl)}.`,
    )
  }

  const allowPrefixes = (input.allowPrefixes ?? [])
    .map(normalizePrefix)
    .filter(Boolean)

  return {
    _tag: 'enabled',
    allowPrefixes,
    edgeCacheTtlSeconds: Math.floor(ttl),
  }
}

function decodePathnameSafely(pathname: string): string {
  try {
    return decodeURIComponent(pathname)
  }
  catch {
    // Malformed percent-encoding is common in scanner requests; classify the raw path instead of throwing 500.
    return pathname
  }
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  const lowerPath = pathname.toLowerCase()
  const lowerPrefix = prefix.toLowerCase()
  if (lowerPrefix.endsWith('/'))
    return lowerPath.startsWith(lowerPrefix)
  return lowerPath === lowerPrefix || lowerPath.startsWith(`${lowerPrefix}/`)
}

function hasHiddenSegment(segments: readonly string[]): boolean {
  return segments.some(segment => segment.startsWith('.'))
}

function lastSegmentExtension(segments: readonly string[]): string | undefined {
  const last = segments.at(-1)
  if (!last)
    return undefined
  const dot = last.lastIndexOf('.')
  if (dot <= 0 || dot === last.length - 1)
    return undefined
  return last.slice(dot).toLowerCase()
}

export function classifyFast404Request(
  pathname: string,
  method = 'GET',
  options: Fast404RuntimeConfig = {},
): Fast404Decision {
  const normalizedMethod = method.toUpperCase()
  if (normalizedMethod === 'OPTIONS')
    return { _tag: 'pass' }

  const decoded = decodePathnameSafely(pathname).replace(/\/{2,}/g, '/')
  const normalized = decoded.startsWith('/') ? decoded : `/${decoded}`
  const segments = normalized.split('/').filter(Boolean)

  // Path traversal segments never bypass dotfile protection via an allowlisted prefix.
  if (segments.includes('..'))
    return { _tag: 'not-found', reason: 'dotfile' }

  const allowPrefixes = options.allowPrefixes?.length
    ? [...DEFAULT_FAST_404_ALLOW_PREFIXES, ...options.allowPrefixes]
    : DEFAULT_FAST_404_ALLOW_PREFIXES

  for (const prefix of allowPrefixes) {
    if (!matchesPrefix(normalized, prefix))
      continue
    // Ensure a hidden file nested under an allowlisted dot-prefix (like `/.well-known/agent-skills/.env`)
    // is still rejected.
    const remainder = normalized.slice(prefix.length)
    const remainderSegments = remainder.split('/').filter(Boolean)
    if (hasHiddenSegment(remainderSegments))
      return { _tag: 'not-found', reason: 'dotfile' }
    return { _tag: 'pass' }
  }

  if (EXACT_ALLOW_PATTERNS.some(pattern => pattern.test(normalized)))
    return { _tag: 'pass' }

  if (hasHiddenSegment(segments))
    return { _tag: 'not-found', reason: 'dotfile' }

  if (CMS_SCANNER_PREFIXES.some(prefix => matchesPrefix(normalized, prefix)))
    return { _tag: 'not-found', reason: 'cms-or-scanner' }

  const extension = lastSegmentExtension(segments)
  if (!extension)
    return { _tag: 'pass' }

  if (SCRIPT_EXTENSIONS.has(extension))
    return { _tag: 'not-found', reason: 'script-extension' }

  if (SAFE_SUFFIX_PATTERNS.some(pattern => pattern.test(normalized)))
    return { _tag: 'pass' }

  if ((normalizedMethod === 'GET' || normalizedMethod === 'HEAD') && STATIC_ASSET_EXTENSIONS.has(extension))
    return { _tag: 'not-found', reason: 'static-extension' }

  return { _tag: 'pass' }
}

export function createFast404Response(
  method = 'GET',
  edgeCacheTtlSeconds = DEFAULT_FAST_404_EDGE_CACHE_TTL_SECONDS,
): Response {
  const edgeCache = edgeCacheTtlSeconds > 0
    ? `public, max-age=${Math.floor(edgeCacheTtlSeconds)}`
    : 'no-store'

  return new Response(method.toUpperCase() === 'HEAD' ? null : 'Not Found', {
    status: 404,
    statusText: 'Not Found',
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'cloudflare-cdn-cache-control': edgeCache,
      'x-robots-tag': 'noindex',
    },
  })
}
