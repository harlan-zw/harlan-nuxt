import type { ErrorReport } from './types'

/**
 * Redaction Rules.
 *
 * `dataCollection: 'scrubbed'` is the module default, so these rules are the
 * only thing standing between a credential and a permanent Sentry issue title.
 * An issue title cannot be edited after the fact, so a leak here is not
 * recoverable by deleting the event.
 *
 * Two independent defences, because either alone has a hole.
 *
 * By KEY name. Catches `apiKey: 'plain-looking-value'`, where the value has no
 * recognisable shape at all.
 *
 * By VALUE shape. Catches a credential smuggled inside a free text field: an
 * ofetch error message quotes the failing URL, query string and all, and no key
 * name exists for it. It also catches a key nobody thought to name.
 *
 * Every function here is pure. None mutates its input, so a caller can hold on
 * to the original report, and a test can assert on the return value alone.
 */

export const REDACTED = '[redacted]'

/** A cyclic object must not loop, and a deep one is never informative. */
const MAX_DEPTH = 6
const MAX_ARRAY_ITEMS = 50

/** Normalised key names that always name a secret. */
const SECRET_KEYS: readonly string[] = [
  'accesskey',
  'accesstoken',
  'apikey',
  'apisecret',
  'auth',
  'authorization',
  'bearer',
  'clientsecret',
  'cookie',
  'credential',
  'credentials',
  'idtoken',
  'jwt',
  'key',
  'passwd',
  'password',
  'privatekey',
  'proxyauthorization',
  'pwd',
  'refreshtoken',
  'secret',
  'secretkey',
  'sessionid',
  'setcookie',
  'signature',
  'token',
]

/**
 * Suffixes, so `googleApiKey`, `clientSecret` and `gscRefreshToken` are caught
 * without a hand written list.
 *
 * A bare `key` suffix is deliberately absent. `cacheKey` and `sortKey` are the
 * fields that make a report debuggable and they carry nothing secret. A real
 * `stripeKey` that slips past the key check is still caught by its value shape.
 */
const SECRET_KEY_SUFFIXES: readonly string[] = [
  'apikey',
  'authorization',
  'password',
  'privatekey',
  'secret',
  'token',
]

/** Request headers that carry the caller identity rather than a credential. */
const PII_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'cf-connecting-ip',
  'forwarded',
  'true-client-ip',
  'x-forwarded-for',
  'x-real-ip',
])

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Whether a key name always holds a secret.
 *
 * @param key The key name, from a header, a body field or an object property.
 * @param extraKeys Names a site adds through `policy.secretKeys`. Matched after
 * the same normalisation, so `X-My-Api` and `xMyApi` are one name.
 */
export function isSecretKey(key: string, extraKeys: readonly string[] = []): boolean {
  const normalized = normalizeKey(key)
  if (!normalized)
    return false
  if (SECRET_KEYS.includes(normalized))
    return true
  if (SECRET_KEY_SUFFIXES.some(suffix => normalized.endsWith(suffix)))
    return true
  return extraKeys.some(extra => normalizeKey(extra) === normalized)
}

/**
 * Value shape rules, applied to every string.
 *
 * Ordered so a broad rule cannot eat the anchor a narrow rule needs. The query
 * string rule runs first because it keeps the parameter name, which is the part
 * that tells a reader which credential leaked.
 */
const VALUE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // `?key=…`, `&access_token=…`, `&sig=…`. The ofetch message leak.
  [/([?&][\w-]*(?:key|token|secret|password|auth|signature|sig|credential|session)[\w-]*=)[^&\s"'`)\]]+/gi, `$1${REDACTED}`],
  // A credential query parameter at the start of a bare query string.
  [/^([\w-]*(?:key|token|secret|password|auth|signature|sig|credential|session)[\w-]*=)[^&\s"'`)\]]+/i, `$1${REDACTED}`],
  // https://user:pass@host
  [/\/\/[^/\s:@]+:[^/\s@]+@/g, `//${REDACTED}@`],
  // `Authorization: Bearer …` and `Basic …`
  [/\b(bearer|basic)\s+[\w\-.~+/]+=*/gi, `$1 ${REDACTED}`],
  // A `Cookie` or `Set-Cookie` header quoted into a message.
  [/\b(cookie|set-cookie)\s*:\s*[^\n\r]+/gi, `$1: ${REDACTED}`],
  // Session cookie assignments, including the names Nuxt and h3 use.
  [/\b(nuxt-session|h3|connect\.sid|__session|session)=[^;\s"'`)\]]+/gi, `$1=${REDACTED}`],
  // JWTs. Google id tokens and our own session tokens.
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, REDACTED],
  // Google OAuth access tokens, refresh tokens and API keys.
  [/\bya29\.[\w-]{10,}/g, REDACTED],
  [/\b1\/\/[\w-]{20,}/g, REDACTED],
  [/\bAIza[\w-]{20,}/g, REDACTED],
  // GitHub
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Z0-9]{20,}/gi, REDACTED],
  [/\bgithub_pat_\w{20,}/g, REDACTED],
  // Stripe
  [/\b(?:sk|rk)_(?:live|test)_[A-Z0-9]{8,}/gi, REDACTED],
  [/\bwhsec_[A-Z0-9]{8,}/gi, REDACTED],
  // Anthropic and OpenAI
  [/\bsk-[\w-]{20,}/g, REDACTED],
  // Resend
  [/\bre_[\w-]{16,}/g, REDACTED],
  // AWS
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}/g, REDACTED],
  // A Sentry DSN carries its own ingest key.
  [/https:\/\/[a-f0-9]{16,}@[\w.-]+\/\d+/gi, REDACTED],
]

/** Strip every credential shape from a string. Returns the string unchanged when clean. */
export function redactText(value: string): string {
  let out = value
  for (const [pattern, replacement] of VALUE_PATTERNS)
    out = out.replace(pattern, replacement)
  return out
}

/**
 * Deep redact an arbitrary value by key name and by value shape.
 *
 * Returns a new value. A cycle becomes `[circular]` and depth past `MAX_DEPTH`
 * becomes `[max depth]`, so a self referencing request body cannot hang the
 * transport. A `BigInt` becomes a string, because Sentry's own normalisation
 * leaves it alone and `JSON.stringify` then throws inside the transport.
 */
export function redactValue(value: unknown, extraKeys: readonly string[] = []): unknown {
  return walk(value, 0, new WeakSet(), extraKeys)
}

function walk(value: unknown, depth: number, seen: WeakSet<object>, extraKeys: readonly string[]): unknown {
  if (typeof value === 'string')
    return redactText(value)
  if (typeof value === 'bigint')
    return String(value)
  if (value === null || typeof value !== 'object')
    return value
  if (seen.has(value))
    return '[circular]'
  if (depth >= MAX_DEPTH)
    return '[max depth]'
  seen.add(value)

  if (value instanceof Error) {
    const cause = (value as Error & { cause?: unknown }).cause
    return {
      name: value.name,
      message: redactText(value.message),
      ...(value.stack ? { stack: redactText(value.stack) } : {}),
      ...(cause === undefined ? {} : { cause: walk(cause, depth + 1, seen, extraKeys) }),
    }
  }

  if (Array.isArray(value)) {
    const items: unknown[] = value.slice(0, MAX_ARRAY_ITEMS).map(item => walk(item, depth + 1, seen, extraKeys))
    if (value.length > MAX_ARRAY_ITEMS)
      items.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`)
    return items
  }

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>))
    out[key] = isSecretKey(key, extraKeys) ? REDACTED : walk(child, depth + 1, seen, extraKeys)
  return out
}

/**
 * Run every Redaction Rule over one Error Report.
 *
 * Returns a new report. The caller hands the result straight back to Sentry, so
 * nothing that survives here can be recalled later.
 */
export function redactErrorReport<T extends ErrorReport>(report: T, extraKeys: readonly string[] = []): T {
  const out: ErrorReport = { ...report }

  if (typeof out.message === 'string')
    out.message = redactText(out.message)

  if (out.exception?.values) {
    out.exception = {
      ...out.exception,
      values: out.exception.values.map(value => typeof value.value === 'string'
        ? { ...value, value: redactText(value.value) }
        : value),
    }
  }

  if (out.breadcrumbs) {
    out.breadcrumbs = out.breadcrumbs.map(crumb => ({
      ...crumb,
      ...(typeof crumb.message === 'string' ? { message: redactText(crumb.message) } : {}),
      ...(crumb.data ? { data: redactValue(crumb.data, extraKeys) as Record<string, unknown> } : {}),
    }))
  }

  if (out.user) {
    // The user id stays. It is what ties a report to an account without naming
    // the person, and it is the field that makes a signed in bug reproducible.
    const { email: _email, username: _username, ip_address: _ip, ...rest } = out.user
    out.user = rest
  }

  if (out.request) {
    const request = { ...out.request }
    // Cookies are pure credential material. A session cookie in a report is
    // account takeover material, and nothing debuggable is lost by dropping it.
    delete request.cookies
    if (typeof request.url === 'string')
      request.url = redactText(request.url)
    // Sentry stores `query_string` without the leading `?`, so the first
    // parameter has no anchor for the query rule. The second value pattern
    // covers exactly that case.
    if (typeof request.query_string === 'string' && request.query_string)
      request.query_string = redactText(request.query_string)
    if (request.headers) {
      const headers: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(request.headers)) {
        headers[key] = isSecretKey(key, extraKeys) || PII_REQUEST_HEADERS.has(key.toLowerCase())
          ? REDACTED
          : redactValue(value, extraKeys)
      }
      request.headers = headers
    }
    // The request body. Deep redact rather than drop: on a 500 the body is
    // usually the whole story, and a settings endpoint posts provider
    // credentials through the same road.
    if (request.data != null)
      request.data = redactValue(request.data, extraKeys)
    out.request = request
  }

  if (out.extra)
    out.extra = redactValue(out.extra, extraKeys) as Record<string, unknown>
  if (out.contexts)
    out.contexts = redactValue(out.contexts, extraKeys) as Record<string, unknown>
  if (out.tags)
    out.tags = redactValue(out.tags, extraKeys) as Record<string, unknown>

  return out as T
}
